import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildFamiliarityIndex, computeFamiliarityRatio } from "../src/engine/familiarity";
import { densifyPolyline, destinationPoint, pointToSegmentDistanceMeters, simplifyByDistance, toSegments } from "../src/engine/utils/geo";
import { LatLng, RouteSegment } from "../src/types";
import { circleLoop, radiusForLoopDistance, straightTrack } from "./helpers/geometry";

const START: LatLng = { lat: 56.9, lng: 12.5 };

/** The original brute-force scoring, kept here as the reference implementation. */
function bruteForceRatio(routeSegments: RouteSegment[], familiarSegments: RouteSegment[]): number {
  let familiarDistance = 0;
  let totalDistance = 0;

  for (const segment of routeSegments) {
    const samples = densifyPolyline([segment.from, segment.to], 12);
    let matches = 0;

    for (const sample of samples) {
      let best = Number.POSITIVE_INFINITY;
      for (const familiar of familiarSegments) {
        const distance = pointToSegmentDistanceMeters(sample, familiar.from, familiar.to);
        if (distance < best) best = distance;
      }
      if (best <= 10) matches += 1;
      else if (best <= 16) matches += 0.8;
      else if (best <= 24) matches += 0.45;
      else if (best <= 35) matches += 0.15;
    }

    totalDistance += segment.distanceMeters;
    familiarDistance += segment.distanceMeters * (samples.length ? matches / samples.length : 0);
  }

  return totalDistance === 0 ? 0 : Math.max(0, Math.min(1, familiarDistance / totalDistance));
}

function routeSegmentsOf(track: LatLng[]): RouteSegment[] {
  return toSegments(simplifyByDistance(track, 18)).filter((segment) => segment.distanceMeters >= 8);
}

describe("spatially indexed familiarity", () => {
  it("agrees with the brute-force reference", () => {
    const cases: Array<{ route: LatLng[]; history: LatLng[][] }> = [
      { route: circleLoop(START, 400), history: [circleLoop(START, 400)] },
      { route: circleLoop(START, 400), history: [circleLoop(START, 403)] }, // 3 m offset
      { route: circleLoop(START, 400), history: [circleLoop(START, 425)] }, // 25 m offset
      { route: circleLoop(START, 400), history: [straightTrack(START, 0, 900, 20)] },
      { route: circleLoop(START, 400), history: [circleLoop({ lat: 57.4, lng: 13.4 }, 400)] },
    ];

    for (const { route, history } of cases) {
      const index = buildFamiliarityIndex(history);
      const segments = routeSegmentsOf(route);
      const fast = computeFamiliarityRatio(segments, index);
      const slow = bruteForceRatio(segments, index.familiarSegments);
      assert.ok(Math.abs(fast - slow) < 1e-9, `grid ${fast} vs brute force ${slow}`);
    }
  });

  it("stays fast on a full season of logged runs", () => {
    // ~60 runs of 8 km sampled every 20 m: the sort of history an ultra runner
    // accumulates around one town, and enough to hang a quadratic scan.
    const history: LatLng[][] = [];
    for (let i = 0; i < 60; i += 1) {
      const origin = destinationPoint(START, (i * 137) % 360, 200 + (i % 10) * 120);
      history.push(straightTrack(origin, (i * 53) % 360, 8_000, 20));
    }
    const totalPoints = history.reduce((sum, track) => sum + track.length, 0);
    assert.ok(totalPoints > 20_000, `expected a big history, got ${totalPoints} points`);

    const startedAt = Date.now();
    const index = buildFamiliarityIndex(history);
    const ratio = computeFamiliarityRatio(routeSegmentsOf(circleLoop(START, radiusForLoopDistance(10_000))), index);
    const elapsed = Date.now() - startedAt;

    assert.ok(ratio >= 0 && ratio <= 1);
    assert.ok(elapsed < 10_000, `familiarity took ${elapsed} ms on ${totalPoints} points`);
  });
});
