import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluateTrafficSafety, WAYTYPE } from "../src/engine/scoring/traffic";

function waytype(entries: Array<[number, number]>) {
  return entries.map(([value, distance]) => ({ value, distance, amount: 0 }));
}

function noise(entries: Array<[number, number]>) {
  return entries.map(([value, distance]) => ({ value, distance, amount: 0 }));
}

describe("evaluateTrafficSafety", () => {
  it("rejects a route with a long stretch of state road", () => {
    const result = evaluateTrafficSafety({
      distanceMeters: 10_000,
      extras: { waytype: waytype([[WAYTYPE.stateRoad, 900], [WAYTYPE.footway, 9_100]]) },
    });
    assert.equal(result.unsafeRoads, true);
    assert.equal(result.stateRoadMeters, 900);
  });

  it("accepts a quiet route on cycleways and footways", () => {
    const result = evaluateTrafficSafety({
      distanceMeters: 10_000,
      extras: {
        waytype: waytype([[WAYTYPE.cycleway, 6_000], [WAYTYPE.footway, 3_000], [WAYTYPE.street, 1_000]]),
        noise: noise([[2, 9_000], [5, 1_000]]),
      },
    });
    assert.equal(result.unsafeRoads, false);
    assert.equal(result.quietWayMeters, 9_000);
    assert.ok(Math.abs(result.quietWayRatio - 0.9) < 1e-9);
    assert.equal(result.trafficPenalty, 0);
  });

  it("rejects a route that is mostly noisy", () => {
    const result = evaluateTrafficSafety({
      distanceMeters: 10_000,
      extras: { noise: noise([[7, 4_000], [2, 6_000]]) },
    });
    assert.equal(result.unsafeRoads, true);
  });

  it("penalises busy roads more than residential streets", () => {
    const busy = evaluateTrafficSafety({
      distanceMeters: 10_000,
      extras: { waytype: waytype([[WAYTYPE.road, 5_000], [WAYTYPE.street, 5_000]]) },
    });
    const calm = evaluateTrafficSafety({
      distanceMeters: 10_000,
      extras: { waytype: waytype([[WAYTYPE.street, 10_000]]) },
    });
    assert.ok(busy.trafficPenalty > calm.trafficPenalty);
  });

  it("judges nothing when the provider returned no extras", () => {
    const result = evaluateTrafficSafety({ distanceMeters: 10_000 });
    assert.equal(result.hasTrafficData, false);
    assert.equal(result.unsafeRoads, false);
    assert.equal(result.trafficPenalty, 0);
  });
});
