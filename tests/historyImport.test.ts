import "./helpers/alias";

import assert from "node:assert/strict";
import { describe, it, before, beforeEach, after } from "node:test";

import { installFakeFirestore, type FakeFirestore } from "./helpers/fakeFirestore";
import {
  buildHistory,
  installFakeIntervals,
  type FakeActivity,
  type FakeIntervals,
} from "./helpers/fakeIntervals";

/**
 * What these tests are actually for.
 *
 * The import's whole promise is that it survives being interrupted: a closed
 * tab, a dropped connection, a rate limit, a second import run months later.
 * That promise is about state that outlives a single call, so it is tested by
 * driving the real `runHistoryBatch` against an in-memory Firestore and a fake
 * intervals.icu, then reading back what landed. The happy path is the least
 * interesting case here.
 */

process.env.TOKEN_ENCRYPTION_KEY =
  process.env.TOKEN_ENCRYPTION_KEY || Buffer.alloc(32, 7).toString("base64");

let db: FakeFirestore;

// The fake database must be in the module cache before anything that reaches
// for a Firestore handle is loaded.
db = installFakeFirestore();

/* eslint-disable @typescript-eslint/no-var-requires */
const { recordConsent } = require("@/lib/ingestion/consent") as typeof import("@/lib/ingestion/consent");
const { saveConnection } = require("@/lib/ingestion/connections") as typeof import("@/lib/ingestion/connections");
const {
  runHistoryBatch,
  loadHistoryProgress,
  countRemaining,
  packStartMinutes,
  HISTORY_MAX_DOWNLOADS,
} = require("@/lib/ingestion/history") as typeof import("@/lib/ingestion/history");
const store = require("@/lib/ingestion/store") as typeof import("@/lib/ingestion/store");
/* eslint-enable @typescript-eslint/no-var-requires */

const UID = "runner-1";

let intervals: FakeIntervals;

async function connect(): Promise<void> {
  await recordConsent({
    uid: UID,
    purpose: "provider_ingest",
    source: "intervals_icu",
    granted: true,
  });
  await saveConnection({
    uid: UID,
    source: "intervals_icu",
    authMode: "api_key",
    result: { externalId: "i1234", displayName: "Test Athlete", apiKey: "not-a-real-key" },
  });
}

/** Drive the import to completion the way the client does, with a safety stop. */
async function runToCompletion(
  options: { maxDownloads?: number; maxBatches?: number } = {},
): Promise<{ batches: number; progress: NonNullable<Awaited<ReturnType<typeof loadHistoryProgress>>> }> {
  const maxBatches = options.maxBatches ?? 200;
  let batches = 0;

  for (;;) {
    const result = await runHistoryBatch({
      uid: UID,
      source: "intervals_icu",
      maxDownloads: options.maxDownloads,
    });
    batches += 1;
    if (result.progress.status === "done") {
      return { batches, progress: result.progress };
    }
    assert.ok(batches < maxBatches, `import did not finish within ${maxBatches} batches`);
  }
}

function storedActivities(): Record<string, unknown>[] {
  return db.docs(store.ACTIVITY_COLLECTION);
}

function earliestStored(): string {
  return storedActivities()
    .map((doc) => String(doc.startedAt))
    .sort()[0];
}

describe("full-history import", () => {
  beforeEach(async () => {
    db = installFakeFirestore();
    await connect();
  });

  after(() => {
    intervals?.restore();
  });

  it("reaches history the old one-year backfill could never see", async () => {
    // Fifteen years, with the gap a real athlete's history has in it.
    const history = buildHistory({ years: [2011, 2012, 2013, 2015, 2016, 2020, 2021, 2024, 2026], runsPerYear: 14 });
    intervals = installFakeIntervals(history);

    const { progress } = await runToCompletion({ maxDownloads: 25 });

    assert.equal(progress.status, "done");
    assert.equal(progress.imported, history.length);
    assert.equal(progress.remaining, 0);
    assert.equal(storedActivities().length, history.length);
    assert.ok(
      earliestStored().startsWith("2011"),
      `expected to reach 2011, reached ${earliestStored()}`,
    );

    // More than one batch, or the per-call ceiling was not doing its job.
    assert.ok(progress.batches > 1, `expected several batches, got ${progress.batches}`);
    intervals.restore();
  });

  it("never downloads more than the per-call ceiling in one batch", async () => {
    const history = buildHistory({ years: [2024, 2025, 2026], runsPerYear: 40 });
    intervals = installFakeIntervals(history);

    const first = await runHistoryBatch({ uid: UID, source: "intervals_icu", maxDownloads: 10 });

    assert.equal(first.downloads, 10);
    assert.ok(first.hitDownloadLimit, "expected the batch to stop at the ceiling");
    assert.equal(intervals.gpxCalls.length, 10);
    assert.equal(first.progress.status, "running");
    intervals.restore();
  });

  it("refuses to be talked into a bigger ceiling than the guard allows", async () => {
    const history = buildHistory({ years: [2025, 2026], runsPerYear: 90 });
    intervals = installFakeIntervals(history);

    const batch = await runHistoryBatch({
      uid: UID,
      source: "intervals_icu",
      maxDownloads: 100_000,
    });

    assert.ok(
      batch.downloads <= HISTORY_MAX_DOWNLOADS,
      `downloaded ${batch.downloads}, ceiling is ${HISTORY_MAX_DOWNLOADS}`,
    );
    intervals.restore();
  });

  it("resumes from the stored frontier after the tab is closed mid-import", async () => {
    const history = buildHistory({ years: [2018, 2019, 2020, 2021, 2022], runsPerYear: 12 });
    intervals = installFakeIntervals(history);

    // Two batches, then the user walks away.
    await runHistoryBatch({ uid: UID, source: "intervals_icu", maxDownloads: 8 });
    const second = await runHistoryBatch({ uid: UID, source: "intervals_icu", maxDownloads: 8 });

    const interrupted = await loadHistoryProgress(UID, "intervals_icu");
    assert.ok(interrupted, "progress should be persisted after every batch");
    assert.equal(interrupted!.status, "running");
    const storedSoFar = storedActivities().length;
    const downloadsSoFar = intervals.gpxCalls.length;
    assert.ok(storedSoFar > 0 && storedSoFar < history.length, "expected a partial import");
    assert.equal(second.progress.frontier, interrupted!.frontier);

    // Days later, a fresh process: nothing in memory, only the progress doc.
    const resumed = await runToCompletion({ maxDownloads: 8 });

    assert.equal(resumed.progress.status, "done");
    assert.equal(storedActivities().length, history.length);
    // Resuming must not restart: the activities already held are never fetched
    // a second time, so total downloads equal the size of the history.
    assert.equal(intervals.gpxCalls.length, history.length);
    assert.ok(intervals.gpxCalls.length > downloadsSoFar);
    assert.equal(new Set(intervals.gpxCalls).size, intervals.gpxCalls.length, "re-downloaded an activity");
    intervals.restore();
  });

  it("resumes after a failed batch without losing the window it was in", async () => {
    const history = buildHistory({ years: [2021, 2022, 2023], runsPerYear: 15 });
    intervals = installFakeIntervals(history);

    const before = await runHistoryBatch({ uid: UID, source: "intervals_icu", maxDownloads: 10 });
    const frontierBefore = before.progress.frontier;

    // The connection drops part-way through the next batch.
    intervals.breakAfterDownloads = intervals.gpxCalls.length + 3;
    await assert.rejects(
      runHistoryBatch({ uid: UID, source: "intervals_icu", maxDownloads: 10 }),
      /fetch failed/,
    );

    const failed = await loadHistoryProgress(UID, "intervals_icu");
    assert.equal(failed!.status, "failed");
    assert.ok(failed!.lastError, "a failed batch must record why");
    assert.equal(failed!.lastError!.code, "sync_failed");
    // The frontier does not move on a failure: the window is still owed.
    assert.equal(failed!.frontier, frontierBefore);

    const recovered = await runToCompletion({ maxDownloads: 10 });
    assert.equal(recovered.progress.status, "done");
    assert.equal(recovered.progress.lastError, undefined, "a later success must clear the error");
    assert.equal(storedActivities().length, history.length);
    intervals.restore();
  });

  it("makes a second full import free: no downloads, no new documents", async () => {
    const history = buildHistory({ years: [2019, 2020, 2021], runsPerYear: 20 });
    intervals = installFakeIntervals(history);

    await runToCompletion({ maxDownloads: 15 });

    const activitiesAfterFirst = storedActivities().length;
    const routesAfterFirst = db.docs(store.ROUTE_COLLECTION).length;
    const downloadsAfterFirst = intervals.gpxCalls.length;
    assert.equal(activitiesAfterFirst, history.length);

    // The user clicks import again, from scratch.
    db.resetCounters();
    const second = await runToCompletion({ maxDownloads: 15 });
    const restarted = await runHistoryBatch({
      uid: UID,
      source: "intervals_icu",
      restart: true,
      maxDownloads: 15,
    });
    assert.ok(restarted.progress.batches >= 1);
    const finishedAgain = await runToCompletion({ maxDownloads: 15 });

    assert.equal(second.progress.status, "done");
    assert.equal(finishedAgain.progress.status, "done");
    // Nothing was pulled from the provider the second time round.
    assert.equal(intervals.gpxCalls.length, downloadsAfterFirst, "a repeat import re-downloaded files");
    // And nothing new was created.
    assert.equal(storedActivities().length, activitiesAfterFirst);
    assert.equal(db.docs(store.ROUTE_COLLECTION).length, routesAfterFirst);
    assert.equal(finishedAgain.progress.imported, 0, "a repeat import claimed to import runs");
    intervals.restore();
  });

  it("steps over an activity the provider cannot serve, and says so", async () => {
    const history = buildHistory({ years: [2024, 2025], runsPerYear: 10 });
    intervals = installFakeIntervals(history);
    // 404: intervals.icu has the activity but no downloadable track.
    intervals.failGpx.set(history[3].id, { status: 404 });
    // 400: a genuine error on one activity, which must not end the import.
    intervals.failGpx.set(history[7].id, { status: 400 });

    const { progress } = await runToCompletion({ maxDownloads: 6 });

    assert.equal(progress.status, "done");
    assert.equal(storedActivities().length, history.length - 2);
    assert.equal(progress.failed, 1, "the 400 should be counted as a failure");
    assert.ok(progress.failedIds.includes(history[7].id));
    assert.ok(progress.skipped >= 1, "the 404 should be counted as skipped, not failed");
    intervals.restore();
  });

  it("leaves treadmill runs and non-foot sports alone, without downloading them", async () => {
    const history: FakeActivity[] = [
      { id: "r1", start_date_local: "2025-03-01T08:00:00", type: "Run", distance: 8000, moving_time: 2400, source: "GARMIN_CONNECT" },
      { id: "t1", start_date_local: "2025-03-02T08:00:00", type: "Run", distance: 8000, moving_time: 2400, trainer: true },
      { id: "v1", start_date_local: "2025-03-03T08:00:00", type: "VirtualRun", distance: 8000, moving_time: 2400 },
      { id: "b1", start_date_local: "2025-03-04T08:00:00", type: "Ride", distance: 30000, moving_time: 3600 },
      { id: "w1", start_date_local: "2025-03-05T08:00:00", type: "Walk", distance: 3000, moving_time: 2400 },
    ];
    intervals = installFakeIntervals(history);

    const { progress } = await runToCompletion();

    assert.equal(progress.imported, 1);
    assert.deepEqual(intervals.gpxCalls, ["r1"], "downloaded something outside the sport policy");
    assert.equal(progress.plannedTotal, 1, "the plan must count only what will be imported");
    intervals.restore();
  });

  it("reports what remains from the frontier, not from counters that drift", async () => {
    const history = buildHistory({ years: [2020, 2021, 2022, 2023], runsPerYear: 12 });
    intervals = installFakeIntervals(history);

    const first = await runHistoryBatch({ uid: UID, source: "intervals_icu", maxDownloads: 7 });
    assert.equal(first.progress.plannedTotal, history.length);
    assert.ok(first.progress.remaining < history.length);
    assert.ok(first.progress.remaining > 0);

    let previous = first.progress.remaining;
    for (;;) {
      const next = await runHistoryBatch({ uid: UID, source: "intervals_icu", maxDownloads: 7 });
      assert.ok(
        next.progress.remaining <= previous,
        `remaining went up: ${previous} -> ${next.progress.remaining}`,
      );
      previous = next.progress.remaining;
      if (next.progress.status === "done") break;
    }

    const final = await loadHistoryProgress(UID, "intervals_icu");
    assert.equal(final!.remaining, 0);
    assert.equal(storedActivities().length, history.length);
    intervals.restore();
  });

  it("records how far back it has reached, so the UI can show it", async () => {
    const history = buildHistory({ years: [2014, 2015, 2024], runsPerYear: 10 });
    intervals = installFakeIntervals(history);

    const { progress } = await runToCompletion({ maxDownloads: 9 });

    assert.ok(progress.oldestImportedAt, "the import must remember how far back it got");
    assert.ok(progress.oldestImportedAt!.startsWith("2014"), progress.oldestImportedAt);
    assert.ok(progress.earliestKnown.startsWith("2014"), progress.earliestKnown);
    assert.equal(progress.oldestImportedAt!.slice(0, 4), progress.earliestKnown.slice(0, 4));
    intervals.restore();
  });

  it("keeps per-batch reads bounded instead of rescanning the whole collection", async () => {
    // The failure mode this guards: loading every activity the user owns on
    // every batch, against a collection the import is itself growing, which is
    // quadratic and blows through the daily read quota long before the import
    // finishes.
    const history = buildHistory({ years: [2020, 2021, 2022, 2023, 2024, 2025], runsPerYear: 20 });
    intervals = installFakeIntervals(history);

    let worstBatchReads = 0;
    let batches = 0;
    for (;;) {
      db.resetCounters();
      const result = await runHistoryBatch({ uid: UID, source: "intervals_icu", maxDownloads: 20 });
      batches += 1;
      worstBatchReads = Math.max(worstBatchReads, db.readCount);
      if (result.progress.status === "done") break;
    }

    assert.equal(storedActivities().length, history.length);
    // A full rescan would read the whole collection twice per batch. Bound the
    // worst batch well under that.
    assert.ok(
      worstBatchReads < history.length,
      `worst batch read ${worstBatchReads} documents for a ${history.length}-activity history`,
    );
    assert.ok(batches > 1);
    intervals.restore();
  });

  it("does not keep a raw copy of every file unless asked to", async () => {
    const history = buildHistory({ years: [2025], runsPerYear: 6 });
    intervals = installFakeIntervals(history);

    await runToCompletion();
    assert.equal(
      db.docs(store.RAW_PAYLOAD_COLLECTION).length,
      0,
      "history import retained raw payloads by default",
    );

    intervals.restore();
  });

  it("retains raw payloads when the caller explicitly opts in", async () => {
    const history = buildHistory({ years: [2025], runsPerYear: 6 });
    intervals = installFakeIntervals(history);

    for (;;) {
      const result = await runHistoryBatch({
        uid: UID,
        source: "intervals_icu",
        retainRawPayload: true,
      });
      if (result.progress.status === "done") break;
    }

    assert.equal(db.docs(store.RAW_PAYLOAD_COLLECTION).length, history.length);
    intervals.restore();
  });
});

describe("remaining-work arithmetic", () => {
  it("counts only what is older than the frontier", () => {
    const packed = packStartMinutes([
      "2020-01-01T00:00:00.000Z",
      "2022-01-01T00:00:00.000Z",
      "2024-01-01T00:00:00.000Z",
    ]);

    assert.equal(countRemaining(packed, "2026-01-01T00:00:00.000Z"), 3);
    assert.equal(countRemaining(packed, "2023-01-01T00:00:00.000Z"), 2);
    assert.equal(countRemaining(packed, "2020-01-01T00:00:00.000Z"), 0);
    assert.equal(countRemaining("", "2026-01-01T00:00:00.000Z"), 0);
  });
});
