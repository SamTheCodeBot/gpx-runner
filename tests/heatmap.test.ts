import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildVisitGrid,
  cellAt,
  daysSince,
  DEFAULT_CELL_METERS,
  frequencyPosition,
  frequencyStops,
  recencyBandIndex,
  summariseGrid,
  type HeatmapRun,
} from "../src/engine/heatmap";

/**
 * The personal heatmap counts runs on the ground, not alpha on the screen.
 *
 * The version this replaces normalised to the busiest pixel, so one loop run
 * fifty times pushed every other road off the bottom of the scale. These tests
 * pin the two properties that failure violated: a count means the same thing
 * at every zoom, and a lopsided history still produces a readable spread.
 */

const HOME = { lat: 56.907, lng: 12.5072 };

function east(meters: number): number {
  return HOME.lng + meters / (111_320 * Math.cos((HOME.lat * Math.PI) / 180));
}

function north(meters: number): number {
  return HOME.lat + meters / 111_320;
}

/** A run straight east from home for `meters`. */
function eastward(meters: number, date?: string): HeatmapRun {
  return { coordinates: [[HOME.lng, HOME.lat], [east(meters), HOME.lat]], date };
}

describe("counting runs, not points", () => {
  it("one run over one road is one visit", () => {
    const grid = buildVisitGrid([eastward(500)]);
    assert.equal(grid.maxVisits, 1);
    assert.equal(cellAt(grid, { lat: HOME.lat, lng: east(250) })?.visits, 1);
  });

  it("the same road three times is three visits", () => {
    const grid = buildVisitGrid([eastward(500), eastward(500), eastward(500)]);
    assert.equal(cellAt(grid, { lat: HOME.lat, lng: east(250) })?.visits, 3);
    assert.equal(grid.maxVisits, 3);
  });

  it("a run crossing its own path still counts once there", () => {
    // Out and back along the same road: one run, one visit, not two.
    const outAndBack: HeatmapRun = {
      coordinates: [
        [HOME.lng, HOME.lat],
        [east(400), HOME.lat],
        [HOME.lng, HOME.lat],
      ],
    };
    assert.equal(buildVisitGrid([outAndBack]).maxVisits, 1);
  });

  it("a densely sampled run does not outweigh a sparse one", () => {
    // Same road, same distance: one run recorded every 5 m, one every 200 m.
    const dense: HeatmapRun = {
      coordinates: Array.from({ length: 101 }, (_, i) => [east(i * 5), HOME.lat] as [number, number]),
    };
    const sparse: HeatmapRun = {
      coordinates: [[HOME.lng, HOME.lat], [east(250), HOME.lat], [east(500), HOME.lat]],
    };

    const grid = buildVisitGrid([dense, sparse]);
    assert.equal(cellAt(grid, { lat: HOME.lat, lng: east(250) })?.visits, 2);
  });

  it("fills the cells between two distant GPS fixes", () => {
    // 500 m apart with nothing in between: the ground was still covered.
    const grid = buildVisitGrid([eastward(500)]);
    for (const meters of [50, 150, 250, 350, 450]) {
      assert.ok(cellAt(grid, { lat: HOME.lat, lng: east(meters) }), `no cell at ${meters} m`);
    }
  });

  it("keeps roads apart that a runner would call separate", () => {
    const grid = buildVisitGrid([eastward(500), { coordinates: [[HOME.lng, north(200)], [east(500), north(200)]] }]);
    assert.equal(cellAt(grid, { lat: HOME.lat, lng: east(250) })?.visits, 1);
    assert.equal(cellAt(grid, { lat: north(200), lng: east(250) })?.visits, 1);
  });

  it("ignores a run with no usable geometry", () => {
    const grid = buildVisitGrid([{ coordinates: [] }, { coordinates: [[HOME.lng, HOME.lat]] }, eastward(200)]);
    assert.equal(grid.runCount, 1);
  });
});

describe("a scale one obsessive loop cannot flatten", () => {
  /** The failure case: one loop run fifty times, plus a lot of one-off ground. */
  function lopsidedHistory(): HeatmapRun[] {
    const runs: HeatmapRun[] = [];
    for (let i = 0; i < 50; i += 1) runs.push(eastward(300));
    for (let i = 1; i <= 20; i += 1) {
      runs.push({ coordinates: [[HOME.lng, north(i * 100)], [east(300), north(i * 100)]] });
    }
    return runs;
  }

  it("still separates once-run ground from twice-run ground", () => {
    const grid = buildVisitGrid(lopsidedHistory());
    const stops = frequencyStops(grid);

    assert.equal(stops[0], 1, "the bottom of the scale is ground run once");
    assert.equal(stops[stops.length - 1], 50, "the top is the real maximum");
    assert.ok(stops.length >= 2, "a scale needs at least two stops");
  });

  it("does not put the whole town at the bottom of the ramp", () => {
    const grid = buildVisitGrid(lopsidedHistory());
    const stops = frequencyStops(grid);

    // Under the old global-max scale, ground run once sat at (1-1)/(50-1) = 0
    // and ground run twice at 0.02 — indistinguishable. The quantile scale has
    // to spread the common case across the ramp instead.
    const once = frequencyPosition(1, stops);
    const top = frequencyPosition(50, stops);
    assert.equal(once, 0);
    assert.equal(top, 1);
    assert.ok(stops.length > 1);
  });

  it("puts the legend's own numbers where the legend says they are", () => {
    // Two runs down one road and one that carries on past it: ground run three
    // times and ground run once, so the scale has real ends to check.
    const grid = buildVisitGrid([eastward(300), eastward(300), eastward(600)]);
    const stops = frequencyStops(grid);

    assert.ok(stops.length > 1, "a history with 1s and 3s in it must produce a scale");

    // Every stop sits exactly on its own tick, so colour and label agree.
    stops.forEach((stop, index) => {
      const expected = index / (stops.length - 1);
      assert.ok(
        Math.abs(frequencyPosition(stop, stops) - expected) < 1e-9,
        `stop ${stop} sat at ${frequencyPosition(stop, stops)}, not ${expected}`,
      );
    });
  });

  it("clamps outside the ends rather than running off the ramp", () => {
    const stops = [1, 3, 10];
    assert.equal(frequencyPosition(0, stops), 0);
    assert.equal(frequencyPosition(99, stops), 1);
  });

  it("survives a history with a single cell", () => {
    const grid = buildVisitGrid([eastward(10)]);
    const stops = frequencyStops(grid);
    assert.ok(stops.length >= 1);
    assert.ok(frequencyPosition(1, stops) >= 0);
  });

  it("collapses to one stop when every metre was run the same number of times", () => {
    // No spread to show, so the legend must not invent one — and the position
    // lookup must not divide by a zero-length scale.
    const grid = buildVisitGrid([eastward(300), eastward(300), eastward(300)]);
    const stops = frequencyStops(grid);

    assert.deepEqual(stops, [3]);
    assert.equal(frequencyPosition(3, stops), 0);
  });

  it("has no scale at all when there is nothing to show", () => {
    assert.deepEqual(frequencyStops(buildVisitGrid([])), []);
    assert.equal(frequencyPosition(5, []), 0);
  });
});

describe("when ground was last touched", () => {
  const now = Date.parse("2026-09-20T12:00:00Z");

  it("remembers the most recent run through a cell, not the first", () => {
    const grid = buildVisitGrid([eastward(300, "2024-01-05"), eastward(300, "2026-09-01")]);
    const cell = cellAt(grid, { lat: HOME.lat, lng: east(150) })!;

    assert.equal(cell.visits, 2);
    assert.ok(daysSince(cell, now)! < 30, `it thought the last run was ${daysSince(cell, now)} days ago`);
  });

  it("bands months rather than drawing a continuous ramp", () => {
    assert.equal(recencyBandIndex(3), 0);
    assert.equal(recencyBandIndex(60), 1);
    assert.equal(recencyBandIndex(120), 2);
    assert.equal(recencyBandIndex(300), 3);
    assert.equal(recencyBandIndex(900), 4);
  });

  it("treats undated ground as the oldest thing on the map", () => {
    const grid = buildVisitGrid([eastward(300)]);
    const cell = cellAt(grid, { lat: HOME.lat, lng: east(150) })!;

    assert.equal(daysSince(cell, now), null);
    assert.equal(recencyBandIndex(null), 4);
  });
});

describe("the sentence above the map", () => {
  it("reports distinct ground, not distance run", () => {
    // The same 500 m road, run four times. Distance run is 2 km; ground is 500 m.
    const grid = buildVisitGrid([eastward(500), eastward(500), eastward(500), eastward(500)]);
    const summary = summariseGrid(grid);

    assert.ok(
      Math.abs(summary.uniqueGroundMeters - 500) <= DEFAULT_CELL_METERS * 2,
      `said ${summary.uniqueGroundMeters} m of ground`,
    );
    assert.equal(summary.maxVisits, 4);
    assert.equal(summary.runCount, 4);
  });

  it("measures the frontier: ground run exactly once", () => {
    const grid = buildVisitGrid([
      eastward(300),
      eastward(300),
      { coordinates: [[HOME.lng, north(500)], [east(300), north(500)]] },
    ]);

    const summary = summariseGrid(grid);
    assert.ok(summary.onceOnlyRatio > 0.4 && summary.onceOnlyRatio < 0.6, `got ${summary.onceOnlyRatio}`);
  });

  it("says nothing rather than dividing by zero", () => {
    const summary = summariseGrid(buildVisitGrid([]));
    assert.equal(summary.uniqueGroundMeters, 0);
    assert.equal(summary.onceOnlyRatio, 0);
    assert.equal(summary.runCount, 0);
  });
});
