import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildFamiliarityIndex, computeFamiliarityRatio } from "../src/engine/familiarity";
import { familiarityRangeForMode } from "../src/engine/config";
import { simplifyByDistance, toSegments } from "../src/engine/utils/geo";
import { LatLng } from "../src/types";
import { circleLoop, halfCircleTrack, radiusForLoopDistance } from "./helpers/geometry";

const START: LatLng = { lat: 56.9, lng: 12.5 };
const FAR_AWAY: LatLng = { lat: 57.4, lng: 13.4 }; // ~80 km away

function ratioAgainst(route: LatLng[], history: LatLng[][]): number {
  const segments = toSegments(simplifyByDistance(route, 18)).filter((segment) => segment.distanceMeters >= 8);
  return computeFamiliarityRatio(segments, buildFamiliarityIndex(history));
}

describe("computeFamiliarityRatio", () => {
  const radius = radiusForLoopDistance(5000);
  const loop = circleLoop(START, radius);

  it("scores a loop that exactly follows a logged track as fully familiar", () => {
    const ratio = ratioAgainst(loop, [loop]);
    assert.ok(ratio >= 0.95, `expected ~1.0, got ${ratio}`);
  });

  it("scores a loop with no logged tracks anywhere near it as unfamiliar", () => {
    const elsewhere = circleLoop(FAR_AWAY, radius);
    const ratio = ratioAgainst(loop, [elsewhere]);
    assert.equal(ratio, 0);
  });

  it("scores a loop that is half known as roughly half familiar", () => {
    const ratio = ratioAgainst(loop, [halfCircleTrack(START, radius)]);
    assert.ok(ratio > 0.35 && ratio < 0.65, `expected ~0.5, got ${ratio}`);
  });

  it("is monotonic: more logged coverage never lowers the ratio", () => {
    const quarter = halfCircleTrack(START, radius).slice(0, 13);
    const half = halfCircleTrack(START, radius);
    const quarterRatio = ratioAgainst(loop, [quarter]);
    const halfRatio = ratioAgainst(loop, [half]);
    const fullRatio = ratioAgainst(loop, [loop]);

    assert.ok(quarterRatio < halfRatio, `${quarterRatio} !< ${halfRatio}`);
    assert.ok(halfRatio < fullRatio, `${halfRatio} !< ${fullRatio}`);
  });

  it("returns 0 when there is no history at all", () => {
    assert.equal(ratioAgainst(loop, []), 0);
  });

  it("tolerates GPS jitter: a track offset by a few metres still counts as familiar", () => {
    const jittered = loop.map((point, index) => ({
      lat: point.lat + (index % 2 === 0 ? 0.00005 : -0.00005), // ~5 m
      lng: point.lng,
    }));
    const ratio = ratioAgainst(loop, [jittered]);
    assert.ok(ratio >= 0.9, `expected jitter-tolerant match, got ${ratio}`);
  });
});

describe("familiarityRangeForMode", () => {
  it("uses the product thresholds from the user story", () => {
    assert.deepEqual(familiarityRangeForMode("familiar"), { min: 0.8, max: 1 });
    assert.deepEqual(familiarityRangeForMode("new"), { min: 0, max: 0.2 });
    assert.deepEqual(familiarityRangeForMode("mixed"), { min: 0.2, max: 0.8 });
  });

  it("puts 0.8 in the familiar band and 0.2 in the unfamiliar band (inclusive edges)", () => {
    const familiar = familiarityRangeForMode("familiar");
    const unfamiliar = familiarityRangeForMode("new");
    assert.ok(0.8 >= familiar.min && 0.8 <= familiar.max);
    assert.ok(0.2 >= unfamiliar.min && 0.2 <= unfamiliar.max);
    assert.ok(0.79 < familiar.min);
    assert.ok(0.21 > unfamiliar.max);
  });
});
