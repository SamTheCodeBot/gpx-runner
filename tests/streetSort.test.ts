import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sortStreetCoverage, type StreetCoverage } from "../src/engine/streets/coverage";

/**
 * The order the street list is read in.
 *
 * The ask was "from most done to not done… so I can see which streets I almost
 * have done and tick those off". The trap is that a finished town is mostly
 * finished streets, so sorting purely by coverage puts a hundred 100%s above
 * the one street at 94% — the only line worth acting on. Done sinks, always.
 */

function street(name: string, ratio: number, lengthMeters: number, complete = false): StreetCoverage {
  const coveredMeters = lengthMeters * ratio;
  return {
    streetId: name,
    name,
    part: 0,
    lengthMeters,
    coveredMeters,
    ratio,
    remainingMeters: lengthMeters - coveredMeters,
    complete,
  };
}

const names = (streets: StreetCoverage[]) => streets.map((entry) => entry.name);

describe("street list ordering", () => {
  it("puts the nearly-done streets first", () => {
    const sorted = sortStreetCoverage(
      [street("Untouched", 0, 400), street("Nearly", 0.85, 400), street("Half", 0.5, 400)],
      "progress",
    );

    assert.deepEqual(names(sorted), ["Nearly", "Half", "Untouched"]);
  });

  it("keeps finished streets out of the way of the nearly-finished ones", () => {
    const sorted = sortStreetCoverage(
      [
        street("DoneA", 1, 400, true),
        street("DoneB", 1, 400, true),
        street("Nearly", 0.94, 400),
        street("DoneC", 1, 400, true),
      ],
      "progress",
    );

    assert.equal(sorted[0].name, "Nearly", "the actionable street leads the list");
    assert.ok(
      sorted.slice(1).every((entry) => entry.complete),
      "everything below it is already done",
    );
  });

  it("breaks a tie at nought percent with the shorter street", () => {
    const sorted = sortStreetCoverage([street("Long", 0, 2000), street("Stub", 0, 60)], "progress");

    assert.deepEqual(names(sorted), ["Stub", "Long"]);
  });

  it("still offers the older ordering, by metres left", () => {
    // 90% of 2 km leaves 200 m; 50% of 100 m leaves 50 m. The two sorts
    // genuinely disagree, which is why both are kept.
    const streets = [street("LongMostlyDone", 0.9, 2000), street("ShortHalfDone", 0.5, 100)];

    assert.deepEqual(names(sortStreetCoverage(streets, "progress")), ["LongMostlyDone", "ShortHalfDone"]);
    assert.deepEqual(names(sortStreetCoverage(streets, "remaining")), ["ShortHalfDone", "LongMostlyDone"]);
  });

  it("sorts by name when asked, done streets still last", () => {
    const sorted = sortStreetCoverage(
      [street("Zebravagen", 0.2, 300), street("Alfavagen", 0.1, 300), street("Betavagen", 1, 300, true)],
      "name",
    );

    assert.deepEqual(names(sorted), ["Alfavagen", "Zebravagen", "Betavagen"]);
  });

  it("does not reorder the caller's array in place", () => {
    const streets = [street("B", 0.1, 300), street("A", 0.9, 300)];
    const before = names(streets);

    sortStreetCoverage(streets, "progress");

    assert.deepEqual(names(streets), before);
  });
});
