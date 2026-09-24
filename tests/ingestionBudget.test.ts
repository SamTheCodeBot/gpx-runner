import "./helpers/alias";

import assert from "node:assert/strict";
import { describe, it, beforeEach, after } from "node:test";

import { installFakeFirestore, type FakeFirestore } from "./helpers/fakeFirestore";
import { installFakeIntervals, type FakeActivity, type FakeIntervals } from "./helpers/fakeIntervals";

/**
 * The ceiling that replaced the one Blaze removed.
 *
 * On the free tier, Firestore itself was the brake: a runaway loop hit 50,000
 * reads and stopped, loudly and at no cost. Blaze takes that away and leaves
 * nothing in its place, which is a worse failure mode rather than a better one
 * — an outage is free and obvious, a runaway is silent and billed. These tests
 * exist to keep the replacement brake honest.
 *
 * The properties that matter: the claim happens BEFORE the work, a spent
 * ceiling refuses rather than warns, the refusal is named so the UI can explain
 * it, and a new day starts clean.
 */

process.env.TOKEN_ENCRYPTION_KEY =
  process.env.TOKEN_ENCRYPTION_KEY || Buffer.alloc(32, 7).toString("base64");

let db: FakeFirestore = installFakeFirestore();

/* eslint-disable @typescript-eslint/no-var-requires */
const { recordConsent } = require("@/lib/ingestion/consent") as typeof import("@/lib/ingestion/consent");
const { saveConnection } = require("@/lib/ingestion/connections") as typeof import("@/lib/ingestion/connections");
const { runIngestion, ingestionErrorCode, ingestionErrorStatus } =
  require("@/lib/ingestion/sync") as typeof import("@/lib/ingestion/sync");
const { runHistoryBatch } = require("@/lib/ingestion/history") as typeof import("@/lib/ingestion/history");
const budget = require("@/lib/ingestion/spendGuard") as typeof import("@/lib/ingestion/spendGuard");
/* eslint-enable @typescript-eslint/no-var-requires */

const UID = "runner-1";

let intervals: FakeIntervals | undefined;

async function connect(): Promise<void> {
  await recordConsent({ uid: UID, purpose: "provider_ingest", source: "intervals_icu", granted: true });
  await saveConnection({
    uid: UID,
    source: "intervals_icu",
    authMode: "api_key",
    result: { externalId: "i1234", displayName: "Test Athlete", apiKey: "***" },
  });
}

function localIso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString().replace(/Z$/, "");
}

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

/** Put the day's counter wherever the test needs it, without running the work. */
function presetBudget(fields: Partial<budgetState>): void {
  const day = budget.budgetDay();
  db.collection(budget.BUDGET_COLLECTION)
    .doc(`${UID}__${day}`)
    .set({ uid: UID, day, downloads: 0, batches: 0, syncs: 0, updatedAt: new Date().toISOString(), ...fields });
}
type budgetState = { downloads: number; batches: number; syncs: number };

describe("the daily ingestion ceiling", () => {
  beforeEach(async () => {
    db = installFakeFirestore();
    await connect();
    intervals?.restore();
    intervals = installFakeIntervals(recentActivities(3));
  });

  after(() => {
    intervals?.restore();
  });

  it("counts a sync and the files it pulled", async () => {
    await runIngestion({ uid: UID, source: "intervals_icu" });

    const state = await budget.readBudget(UID);
    assert.equal(state.syncs, 1);
    assert.equal(state.downloads, 3);
  });

  it("refuses a sync once the day's syncs are spent", async () => {
    presetBudget({ syncs: budget.DAILY_SYNC_BUDGET });

    await assert.rejects(
      () => runIngestion({ uid: UID, source: "intervals_icu" }),
      (error: unknown) => {
        assert.ok(error instanceof budget.BudgetExhaustedError);
        assert.equal(ingestionErrorCode(error), "daily_budget_exhausted");
        assert.equal(ingestionErrorStatus("daily_budget_exhausted"), 503);
        return true;
      },
    );
  });

  it("refuses BEFORE spending anything at the provider", async () => {
    presetBudget({ syncs: budget.DAILY_SYNC_BUDGET });

    await assert.rejects(() => runIngestion({ uid: UID, source: "intervals_icu" }));

    // The whole point of a ceiling is that it stops the spend. A guard that
    // reports afterwards is a log line, not a control.
    assert.equal(intervals!.gpxCalls.length, 0, "a refused sync still downloaded files");
    assert.equal(intervals!.listCalls.length, 0, "a refused sync still called the provider");
  });

  it("stops a history import that will not stop itself", async () => {
    presetBudget({ batches: budget.DAILY_BATCH_BUDGET });

    await assert.rejects(
      () => runHistoryBatch({ uid: UID, source: "intervals_icu" }),
      (error: unknown) => {
        assert.equal(ingestionErrorCode(error), "daily_budget_exhausted");
        return true;
      },
    );
    assert.equal(intervals!.gpxCalls.length, 0);
  });

  it("lets a normal import through untouched", async () => {
    // The real account is 1,434 activities: about 15 batches at the ceiling of
    // 100 downloads each. A budget that a legitimate import can reach is a bug
    // report waiting to happen, so the headroom is asserted rather than assumed.
    assert.ok(
      budget.DAILY_BATCH_BUDGET >= 15 * 4,
      `batch budget ${budget.DAILY_BATCH_BUDGET} leaves too little room for a full import`,
    );
    assert.ok(
      budget.DAILY_DOWNLOAD_BUDGET >= 1_434 * 2,
      `download budget ${budget.DAILY_DOWNLOAD_BUDGET} leaves too little room for a full import`,
    );

    const batch = await runHistoryBatch({ uid: UID, source: "intervals_icu", maxDownloads: 10 });
    assert.ok(batch.downloads > 0);

    const state = await budget.readBudget(UID);
    assert.equal(state.batches, 1);
    assert.equal(state.downloads, batch.downloads);
  });

  it("starts each UTC day clean", async () => {
    presetBudget({ syncs: budget.DAILY_SYNC_BUDGET });

    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const state = await budget.readBudget(UID, tomorrow);

    assert.equal(state.syncs, 0);
    assert.equal(await budget.budgetSpent(UID, "syncs", tomorrow), false);
  });

  it("names the day in UTC, not in the reader's timezone", () => {
    const newYearInStockholm = new Date("2026-01-01T00:30:00+01:00");
    assert.equal(budget.budgetDay(newYearInStockholm), "2025-12-31");
  });
});
