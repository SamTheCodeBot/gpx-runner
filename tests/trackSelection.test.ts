import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { boundTracksNearStart, historyCenter, selectTracksNearStart } from "../src/engine/trackHistory";
import type { LatLng } from "../src/types";

/**
 * Choosing which runs go to the suggestion endpoint.
 *
 * The bug this replaces: every coordinate of every run was converted into a
 * `{lat, lng}` object, and then the first 150 tracks were kept and the rest
 * thrown away — synchronously, inside a click handler. Two faults in one line:
 * an entire history allocated to discard most of it, and "the first 150" is an
 * arbitrary slice in array order rather than the runs anywhere near the start.
 */

const START: LatLng = { lat: 56.907, lng: 12.5072 };

function east(meters: number): number {
  return START.lng + meters / (111_320 * Math.cos((START.lat * Math.PI) / 180));
}

function north(meters: number): number {
  return START.lat + meters / 111_320;
}

/** A short run at a given distance north of the start. */
function runAt(metersNorth: number): { coordinates: [number, number][] } {
  return {
    coordinates: [
      [START.lng, north(metersNorth)],
      [east(200), north(metersNorth)],
    ],
  };
}

describe("picking the runs near a start point", () => {
  it("keeps what is inside the radius and drops what is not", () => {
    const routes = [runAt(100), runAt(50_000), runAt(300)];
    const picked = selectTracksNearStart(routes, START, 2000, 150);

    assert.equal(picked.length, 2);
  });

  it("returns the nearest runs first, not the first ones logged", () => {
    // The order that used to decide it: furthest logged first.
    const routes = [runAt(1800), runAt(200), runAt(900)];
    const picked = selectTracksNearStart(routes, START, 5000, 3);

    const distances = picked.map((track) => Math.round((track[0].lat - START.lat) * 111_320));
    assert.deepEqual(distances, [200, 900, 1800]);
  });

  it("keeps the nearest when more runs qualify than the cap allows", () => {
    // Twenty runs marching away from the start; only the closest three fit.
    const routes = Array.from({ length: 20 }, (_, i) => runAt((i + 1) * 100));
    const picked = selectTracksNearStart(routes, START, 50_000, 3);

    assert.equal(picked.length, 3);
    const distances = picked.map((track) => Math.round((track[0].lat - START.lat) * 111_320));
    assert.deepEqual(distances, [100, 200, 300]);
  });

  it("counts a run that merely passes nearby, wherever it starts", () => {
    // Starts 40 km away and runs in to the start point: it is near, and the
    // old first-150-in-order slice had no way of knowing that.
    const passerby = {
      coordinates: [
        [START.lng, north(40_000)],
        [START.lng, north(10)],
      ] as [number, number][],
    };

    assert.equal(selectTracksNearStart([passerby], START, 1000, 150).length, 1);
  });

  it("converts to the shape the bounding step expects", () => {
    const [track] = selectTracksNearStart([runAt(100)], START, 2000, 150);

    assert.ok(track.length >= 2);
    assert.equal(typeof track[0].lat, "number");
    assert.equal(typeof track[0].lng, "number");
  });

  it("feeds boundTracksNearStart without changing what comes out", () => {
    const routes = [runAt(100), runAt(200)];
    const bounded = boundTracksNearStart(selectTracksNearStart(routes, START, 5000, 150), START, {
      radiusMeters: 5000,
    });

    assert.equal(bounded.length, 2);
  });

  it("ignores rubbish instead of throwing on it", () => {
    const routes = [
      { coordinates: null },
      { coordinates: [] },
      { coordinates: [[START.lng, START.lat]] },
      runAt(100),
    ];

    assert.equal(selectTracksNearStart(routes as never, START, 2000, 150).length, 1);
  });

  it("returns nothing when the history is nowhere near", () => {
    assert.deepEqual(selectTracksNearStart([runAt(80_000)], START, 2000, 150), []);
  });
});

describe("the centre of a history", () => {
  it("averages every point without building an array of them", () => {
    const routes = [
      { coordinates: [[0, 0], [0, 0]] as [number, number][] },
      { coordinates: [[2, 2], [2, 2]] as [number, number][] },
    ];

    const center = historyCenter(routes);
    assert.equal(center?.lat, 1);
    assert.equal(center?.lng, 1);
  });

  it("skips coordinates that are not numbers", () => {
    const routes = [{ coordinates: [[0, 0], ["x", 1], [2, 2]] }];
    const center = historyCenter(routes as never);

    assert.equal(center?.lat, 1);
    assert.equal(center?.lng, 1);
  });

  it("says nothing rather than returning NaN", () => {
    assert.equal(historyCenter([]), null);
    assert.equal(historyCenter([{ coordinates: [] }]), null);
  });
});
