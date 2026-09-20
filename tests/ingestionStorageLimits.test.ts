import "./helpers/alias";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { IntervalsApiError } from "@/lib/intervals";
import { ingestionErrorCode } from "@/lib/ingestion/sync";
import { MAX_STORED_SAMPLES, MAX_STORED_TRACK_POINTS, thinForStorage } from "@/lib/ingestion/store";

/**
 * The failure these guard against: intervals.icu serves its GPX from per-second
 * streams, so a long run arrives as tens of thousands of points regardless of
 * what the watch recorded, and the Firestore write for that one activity was
 * rejected. The loop had already written the shorter runs, so the import looked
 * half-finished and every retry died in the same place.
 */

describe("track thinning for storage", () => {
  it("leaves a short track exactly as it was", () => {
    const points = Array.from({ length: 120 }, (_, index) => index);
    assert.deepEqual(thinForStorage(points, 4000), points);
  });

  it("caps a per-second ultra at the stored limit", () => {
    // Nine hours at 1 Hz — the kind of run that used to fail the write.
    const points = Array.from({ length: 32_400 }, (_, index) => index);
    const thinned = thinForStorage(points, MAX_STORED_TRACK_POINTS);

    assert.ok(thinned.length <= MAX_STORED_TRACK_POINTS + 1, `kept ${thinned.length}`);
    assert.ok(thinned.length > MAX_STORED_TRACK_POINTS / 2, "thinned far more than asked");
  });

  it("thins, never truncates: the run still ends where he stopped", () => {
    const points = Array.from({ length: 10_000 }, (_, index) => index);
    const thinned = thinForStorage(points, MAX_STORED_TRACK_POINTS);

    assert.equal(thinned[0], 0);
    assert.equal(thinned[thinned.length - 1], 9_999);
  });

  it("keeps the points in order and spaced evenly", () => {
    const points = Array.from({ length: 1000 }, (_, index) => index);
    const thinned = thinForStorage(points, 100);

    for (let i = 1; i < thinned.length; i += 1) {
      assert.ok(thinned[i] > thinned[i - 1], "order was not preserved");
    }
  });

  it("holds samples to the cap the browser upload path already used", () => {
    assert.equal(MAX_STORED_SAMPLES, 900);
    const samples = Array.from({ length: 12_000 }, (_, index) => index);
    assert.ok(thinForStorage(samples, MAX_STORED_SAMPLES).length <= MAX_STORED_SAMPLES + 1);
  });
});

describe("ingestion error codes", () => {
  it("names an oversized document instead of a bare sync_failed", () => {
    const tooBig = new Error(
      '3 INVALID_ARGUMENT: The value of property "coordinates" is longer than 1048487 bytes.',
    );
    assert.equal(ingestionErrorCode(tooBig), "activity_too_large");
  });

  it("names an over-indexed document too", () => {
    const tooManyEntries = new Error("too many index entries for entity");
    assert.equal(ingestionErrorCode(tooManyEntries), "activity_too_large");
  });

  it("still reports provider failures as provider failures", () => {
    assert.equal(
      ingestionErrorCode(new IntervalsApiError("rate limited", 429, "")),
      "intervals_rate_limited",
    );
    assert.equal(ingestionErrorCode(new Error("something else entirely")), "sync_failed");
  });
});
