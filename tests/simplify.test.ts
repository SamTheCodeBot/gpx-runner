import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { simplifyByPointBudget, simplifyToBudget } from "../src/lib/track/simplify";

type Coordinate = [number, number];

function toLocalMeters(point: Coordinate, refLatRad: number): [number, number] {
  const EARTH_RADIUS_M = 6371000;
  const [lon, lat] = point;
  const x = ((lon * Math.PI) / 180) * EARTH_RADIUS_M * Math.cos(refLatRad);
  const y = ((lat * Math.PI) / 180) * EARTH_RADIUS_M;
  return [x, y];
}

function pointDistanceMeters(a: Coordinate, b: Coordinate): number {
  const refLatRad = (a[1] * Math.PI) / 180;
  const [ax, ay] = toLocalMeters(a, refLatRad);
  const [bx, by] = toLocalMeters(b, refLatRad);
  return Math.hypot(ax - bx, ay - by);
}

/**
 * A synthetic out-and-back with gentle real-street-like wander (a sine
 * perturbation large enough that Douglas-Peucker-style epsilon simplification
 * cannot collapse a whole leg to its two endpoints -- that was this fixture's
 * first, too-easy version, which a straight-line leg passed trivially without
 * exercising anything). Two parallel legs ~9m apart, ~3.9km each way.
 */
function outAndBack(legPoints: number, stepDeg: number, lon1: number, lon2: number, startLat: number, wiggleDeg: number): Coordinate[] {
  const coords: Coordinate[] = [];
  for (let i = 0; i < legPoints; i += 1) {
    const wiggle = Math.sin(i / 23) * wiggleDeg;
    coords.push([lon1 + wiggle, startLat + i * stepDeg]);
  }
  for (let i = legPoints; i >= 0; i -= 1) {
    const wiggle = Math.sin(i / 23) * wiggleDeg;
    coords.push([lon2 + wiggle, startLat + i * stepDeg]);
  }
  return coords;
}

const LEG_POINTS = 500;
const STEP_DEG = 0.00007; // ~7.8m of latitude per raw sample
const LON1 = 18.07;
const LON2 = 18.07012; // ~9m east of LON1 at this latitude
const START_LAT = 59.3;
const WIGGLE_DEG = 15 / 56800; // ~15m amplitude, period ~180m: a real street, not a straight line
const TURNAROUND_INDEX = LEG_POINTS; // the point where direction reverses

function fixture(): Coordinate[] {
  return outAndBack(LEG_POINTS, STEP_DEG, LON1, LON2, START_LAT, WIGGLE_DEG);
}

function naiveIndexThin(coords: Coordinate[], maxPoints: number): Coordinate[] {
  if (coords.length <= maxPoints) return coords;
  const step = Math.ceil(coords.length / maxPoints);
  return coords.filter((_, i) => i % step === 0 || i === coords.length - 1);
}

describe("simplifyToBudget", () => {
  it("never returns more than the requested budget", () => {
    const result = simplifyToBudget(fixture(), 120);
    assert.ok(result.length <= 120, "result length " + result.length + " exceeds budget");
  });

  it("keeps the first and last point", () => {
    const coords = fixture();
    const result = simplifyToBudget(coords, 120);
    assert.deepEqual(result[0], coords[0]);
    assert.deepEqual(result[result.length - 1], coords[coords.length - 1]);
  });

  it("passes through unchanged when already under budget", () => {
    const coords: Coordinate[] = [[18.0, 59.3], [18.001, 59.301], [18.002, 59.302]];
    const result = simplifyToBudget(coords, 120);
    assert.deepEqual(result, coords);
  });

  it("demonstrates the bug this replaces: naive index thinning really does stitch across the out-and-back gap", () => {
    const naive = naiveIndexThin(fixture(), 120);
    // A point just before the turnaround in the ORIGINAL sequence and a
    // point just after it are only ~9m apart on the ground. If naive
    // thinning's surviving points straddle the turnaround with a gap far
    // bigger than that, it proves this fixture reproduces the real bug.
    let sawOversizedJumpNearTurn = false;
    for (let i = 1; i < naive.length; i += 1) {
      const dist = pointDistanceMeters(naive[i - 1], naive[i]);
      if (dist > 50) sawOversizedJumpNearTurn = true;
    }
    assert.ok(sawOversizedJumpNearTurn, "fixture did not reproduce the naive-thinning artefact -- check it before touching the fix");
  });

  it("never connects a point on one leg directly to a point on the other leg", () => {
    const coords = fixture();
    const result = simplifyToBudget(coords, 120);

    // Every original point's index tells us which leg it is on.
    const originalIndexOf = new Map<string, number>();
    coords.forEach((p, i) => originalIndexOf.set(p[0] + "," + p[1], i));

    for (let i = 1; i < result.length; i += 1) {
      const prevIdx = originalIndexOf.get(result[i - 1][0] + "," + result[i - 1][1])!;
      const currIdx = originalIndexOf.get(result[i][0] + "," + result[i][1])!;
      const prevLeg = prevIdx <= TURNAROUND_INDEX ? "out" : "back";
      const currLeg = currIdx <= TURNAROUND_INDEX ? "out" : "back";

      if (prevLeg !== currLeg) {
        // The only legitimate out-leg-to-back-leg transition is AT the
        // turnaround itself -- both indices must be within a few samples
        // of TURNAROUND_INDEX, never a point from deep in one leg jumping
        // straight to a point deep in the other.
        assert.ok(
          Math.abs(prevIdx - TURNAROUND_INDEX) < 10 && Math.abs(currIdx - TURNAROUND_INDEX) < 10,
          "leg transition far from the turnaround: original indices " + prevIdx + " -> " + currIdx,
        );
      }
    }
  });

  it("stays fast on the largest track this app ever stores (MAX_STORED_TRACK_POINTS = 4000)", () => {
    const coords = outAndBack(2000, STEP_DEG, LON1, LON2, START_LAT, WIGGLE_DEG);
    const start = Date.now();
    simplifyToBudget(coords, 120);
    const elapsedMs = Date.now() - start;
    // Generous ceiling -- this is a cost-bound regression guard (the whole
    // point of PRE_SIMPLIFY_CAP's distance-based pre-thin), not a tight
    // performance benchmark. Real failure mode is "seconds," not "a few
    // milliseconds," and this endpoint may do this for hundreds of routes
    // in one request.
    assert.ok(elapsedMs < 500, "took " + elapsedMs + "ms for one route -- cost bound regressed");
  });

  it("simplifyByPointBudget keeps a sharp right-angle corner over nearly-collinear points", () => {
    const corner: Coordinate[] = [];
    for (let i = 0; i <= 20; i += 1) corner.push([18.0 + i * 0.0001, 59.3]);
    for (let i = 1; i <= 20; i += 1) corner.push([18.002, 59.3 + i * 0.0001]);

    const simplified = simplifyByPointBudget(corner, 5);
    assert.equal(simplified.length, 5);
    // The corner vertex (index 20, where the turn happens) contributes far
    // more shape than any nearly-collinear point along either straight
    // flank, so it must be among the handful kept.
    assert.ok(simplified.some((p) => p[0] === corner[20][0] && p[1] === corner[20][1]));
  });
});
