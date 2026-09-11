import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  boundTracksNearStart,
  historyRadiusMeters,
  splitInsideRadius,
  thin,
  toLatLngTrack,
} from "../src/engine/trackHistory";
import { haversineMeters, polylineDistanceMeters } from "../src/engine/utils/geo";
import { LatLng } from "../src/types";
import { circleLoop, radiusForLoopDistance, straightTrack } from "./helpers/geometry";

const START: LatLng = { lat: 56.9, lng: 12.5 };

describe("historyRadiusMeters", () => {
  it("scales with the target distance but stays bounded", () => {
    assert.equal(historyRadiusMeters(1), 2_000);
    assert.equal(historyRadiusMeters(10), 10_000);
    assert.equal(historyRadiusMeters(120), 30_000);
  });
});

describe("boundTracksNearStart", () => {
  it("drops activities that are nowhere near the start point", () => {
    const near = circleLoop(START, radiusForLoopDistance(5_000));
    const far = circleLoop({ lat: 57.4, lng: 13.4 }, radiusForLoopDistance(5_000));

    const bounded = boundTracksNearStart([near, far], START, { radiusMeters: 5_000 });
    assert.equal(bounded.length, 1);
  });

  it("thins tracks instead of posting every coordinate", () => {
    const dense = straightTrack(START, 90, 4_000, 2); // a point every 2 m
    const [bounded] = boundTracksNearStart([dense], START, { radiusMeters: 10_000 });

    assert.ok(bounded.length < dense.length / 5, `expected heavy thinning, got ${bounded.length}/${dense.length}`);
    // The shape survives: the thinned track still covers the same ground.
    const lost = Math.abs(polylineDistanceMeters(dense) - polylineDistanceMeters(bounded));
    assert.ok(lost < 100, `thinning moved the track by ${lost} m`);
  });

  it("never stitches a straight line across ground the runner did not cover", () => {
    // Out 6 km east and back — only the first and last kilometre are near home.
    const out = straightTrack(START, 90, 6_000, 50);
    const back = [...out].reverse();
    const track = [...out, ...back];

    const bounded = boundTracksNearStart([track], START, { radiusMeters: 1_000 });

    assert.ok(bounded.length >= 2, "expected the excursion to be split into separate stretches");
    for (const stretch of bounded) {
      for (const point of stretch) {
        assert.ok(haversineMeters(START, point) <= 1_000 + 1e-6);
      }
      for (let i = 1; i < stretch.length; i += 1) {
        assert.ok(
          haversineMeters(stretch[i - 1], stretch[i]) < 500,
          "a bounded stretch must not contain a jump across dropped ground",
        );
      }
    }
  });

  it("respects the total point budget", () => {
    const tracks = Array.from({ length: 40 }, () => straightTrack(START, 45, 3_000, 5));
    const bounded = boundTracksNearStart(tracks, START, { radiusMeters: 10_000, maxTotalPoints: 500 });
    const total = bounded.reduce((sum, track) => sum + track.length, 0);

    assert.ok(total <= 700, `expected the budget to cap the payload, got ${total} points`);
  });

  it("ignores malformed coordinates", () => {
    const track = toLatLngTrack([
      [12.5, 56.9],
      ["x", 1],
      [12.501, 56.9],
      null,
      [12.502],
    ]);
    assert.equal(track.length, 2);
    assert.deepEqual(track, [
      { lat: 56.9, lng: 12.5 },
      { lat: 56.9, lng: 12.501 },
    ]);
  });
});

describe("thin", () => {
  it("keeps the first and last point", () => {
    const track = straightTrack(START, 0, 2_000, 5);
    const thinned = thin(track, 20);
    assert.ok(thinned.length <= 20);
    assert.deepEqual(thinned[0], track[0]);
    assert.equal(haversineMeters(thinned[thinned.length - 1], track[track.length - 1]) < 200, true);
  });
});

describe("splitInsideRadius", () => {
  it("returns nothing when the whole track is out of range", () => {
    const track = straightTrack({ lat: 57.4, lng: 13.4 }, 0, 1_000, 50);
    assert.deepEqual(splitInsideRadius(track, START, 1_000), []);
  });
});
