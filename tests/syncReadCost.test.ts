import "./helpers/alias";

import assert from "node:assert/strict";
import { describe, it, beforeEach, after } from "node:test";

import { installFakeFirestore, type FakeFirestore } from "./helpers/fakeFirestore";
import { installFakeIntervals, type FakeActivity, type FakeIntervals } from "./helpers/fakeIntervals";

/**
 * What a sync is allowed to cost.
 *
 * The reconciliation pull answers a question about a 30-day window, and it used
 * to answer it by reading every activity the account owns — twice, once for
 * "have I seen this id" and once for the dedupe candidates. On an account with
 * a full history imported that is a few thousand document reads per sync, per
 * webhook delivery, for ever. On 2026-09-23 it emptied the Firestore free tier's
 * daily read allowance and took the whole app down with it: every page that
 * reads the database returned 500, and the intervals.icu card on the profile
 * page said `Failed to load connection state` with no clue as to why.
 *
 * So the cost is now a test, not a comment. The assertion that matters is not a
 * magic number of reads but the shape: a sync of the same window must not get
 * more expensive because the account has more history behind it.
 */

process.env.TOKEN_ENCRYPTION_KEY =
  process.env.TOKEN_ENCRYPTION_KEY || Buffer.alloc(32, 7).toString("base64");

let db: FakeFirestore = installFakeFirestore();

/* eslint-disable @typescript-eslint/no-var-requires */
const { recordConsent } = require("@/lib/ingestion/consent") as typeof import("@/lib/ingestion/consent");
const { saveConnection } = require("@/lib/ingestion/connections") as typeof import("@/lib/ingestion/connections");
const { runIngestion, ingestionErrorCode, ingestionErrorStatus } =
  require("@/lib/ingestion/sync") as typeof import("@/lib/ingestion/sync");
const store = require("@/lib/ingestion/store") as typeof import("@/lib/ingestion/store");
/* eslint-enable @typescript-eslint/no-var-requires */

const UID = "runner-1";

let intervals: FakeIntervals | undefined;

async function connect(): Promise<void> {
  await recordConsent({ uid: UID, purpose: "provider_ingest", source: "intervals_icu", granted: true });
  await saveConnection({
    uid: UID,
    source: "intervals_icu",
    authMode: "api_key",
    result: { externalId: "i1234", displayName: "Test Athlete", apiKey: "not-a-real-key" },
  });
}

/** Local ISO with no offset, the way intervals.icu serves it. */
function localIso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString().replace(/Z$/, "");
}

/** Activities inside the default 30-day reconciliation window. */
function recentActivities(count: number): FakeActivity[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `recent-${index}`,
    start_date_local: localIso(index + 1),
    type: "Run",
    distance: 10_000 + index,
    moving_time: 3_000,
    total_elevation_gain: 40,
  }));
}

/**
 * History already in the database, written straight to the collection.
 *
 * These are the documents the old code read on every sync and threw away:
 * `findDuplicate` skips same-source candidates on its first line, and the ids
 * are outside the window being reconciled.
 */
function seedStoredHistory(count: number): void {
  for (let index = 0; index < count; index += 1) {
    const id = `intervals_icu__old-${index}`;
    db.collection(store.ACTIVITY_COLLECTION).doc(id).set({
      id,
      ownerUid: UID,
      source: "intervals_icu",
      sourceActivityId: `old-${index}`,
      startedAt: new Date(Date.now() - (400 + index) * 24 * 60 * 60 * 1000).toISOString(),
      distanceMeters: 12_000 + index,
      fingerprint: `fp-${index}`,
      startPoint: [12.49, 56.9],
    });
  }
}

async function syncReadCost(storedHistory: number): Promise<number> {
  db = installFakeFirestore();
  await connect();
  seedStoredHistory(storedHistory);

  intervals?.restore();
  intervals = installFakeIntervals(recentActivities(3));

  db.resetCounters();
  await runIngestion({ uid: UID, source: "intervals_icu" });
  return db.readCount;
}

describe("sync read cost", () => {
  beforeEach(() => {
    db = installFakeFirestore();
  });

  after(() => {
    intervals?.restore();
  });

  it("does not get more expensive as the account's history grows", async () => {
    const small = await syncReadCost(10);
    const large = await syncReadCost(600);

    // The old implementation read every stored activity twice, so this
    // difference would have been about 1,180.
    assert.equal(
      large,
      small,
      `a sync of the same window cost ${small} reads against 10 stored activities and ${large} against 600`,
    );
  });

  it("keeps a single sync well under the per-window ceiling", async () => {
    const reads = await syncReadCost(600);

    // Consent, connection, the bounded id lookup, the foreign-source dedupe
    // queries and one read per activity written. Nowhere near the history.
    assert.ok(reads < 60, `expected a small bounded read count, got ${reads}`);
  });

  it("still imports what the window holds", async () => {
    db = installFakeFirestore();
    await connect();
    seedStoredHistory(25);

    intervals?.restore();
    intervals = installFakeIntervals(recentActivities(3));

    const result = await runIngestion({ uid: UID, source: "intervals_icu" });

    assert.equal(result.imported, 3);
    assert.equal(db.docs(store.ACTIVITY_COLLECTION).length, 28);
  });

  it("skips what it already holds without reading the whole collection", async () => {
    db = installFakeFirestore();
    await connect();

    intervals?.restore();
    intervals = installFakeIntervals(recentActivities(3));

    await runIngestion({ uid: UID, source: "intervals_icu" });
    const downloadsAfterFirst = intervals.gpxCalls.length;

    await runIngestion({ uid: UID, source: "intervals_icu" });

    assert.equal(intervals.gpxCalls.length, downloadsAfterFirst, "a repeat sync re-downloaded files");
    assert.equal(db.docs(store.ACTIVITY_COLLECTION).length, 3);
  });
});

describe("a spent Firestore quota is named, not swallowed", () => {
  /** What `firebase-admin` throws once the day's free allowance is gone. */
  function resourceExhausted(): Error & { code: number } {
    const error = new Error("8 RESOURCE_EXHAUSTED: Quota exceeded.") as Error & { code: number };
    error.code = 8;
    return error;
  }

  it("classifies the gRPC status, the string and the REST status alike", () => {
    assert.equal(ingestionErrorCode(resourceExhausted()), "firestore_quota_exhausted");

    const restStyle = Object.assign(new Error("Quota exceeded."), { status: 429 });
    assert.equal(ingestionErrorCode(restStyle), "firestore_quota_exhausted");

    const messageOnly = new Error("Error: 8 RESOURCE_EXHAUSTED: Quota exceeded.");
    assert.equal(ingestionErrorCode(messageOnly), "firestore_quota_exhausted");
  });

  it("is not mistaken for intervals.icu rate-limiting us", () => {
    // Both are "429-ish"; only one of them is fixed by waiting a few minutes,
    // and the copy the user sees differs accordingly.
    assert.notEqual(ingestionErrorCode(resourceExhausted()), "intervals_rate_limited");
    assert.equal(ingestionErrorStatus("firestore_quota_exhausted"), 503);
  });

  it("does not claim every error is a quota problem", () => {
    assert.equal(ingestionErrorCode(new Error("fetch failed")), "sync_failed");
    assert.equal(ingestionErrorCode(new Error("some other database complaint")), "sync_failed");
  });
});
