import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildFamiliarityIndex } from "../src/engine/familiarity";
import {
  STREET_COMPLETE_RATIO,
  computeProjectCoverage,
  computeStreetCoverage,
  isStreetComplete,
  splitStreetByCoverage,
} from "../src/engine/streets/coverage";
import { buildStreetInventory, type OsmWay } from "../src/engine/streets/inventory";
import { computeProjectProgress } from "../src/engine/streets/project";
import { circleScope } from "../src/engine/streets/scope";
import { destinationPoint, polylineDistanceMeters } from "../src/engine/utils/geo";
import { FALKENBERG_HOME, falkenbergWays } from "./helpers/falkenbergStreets";
import type { LatLng } from "../src/types";

const HOME: LatLng = FALKENBERG_HOME;

function straightWay(id: number, name: string, start: LatLng, bearingDeg: number, lengthMeters: number): OsmWay {
  const steps = Math.max(2, Math.round(lengthMeters / 20));
  const geometry: LatLng[] = [];
  for (let i = 0; i <= steps; i += 1) geometry.push(destinationPoint(start, bearingDeg, (lengthMeters * i) / steps));
  return { id, tags: { name, highway: "residential" }, geometry };
}

/** A GPS trace down `fraction` of a straight street, sampled like a watch would. */
function runAlong(start: LatLng, bearingDeg: number, lengthMeters: number, fraction: number): LatLng[] {
  const covered = lengthMeters * fraction;
  const steps = Math.max(2, Math.round(covered / 10));
  const track: LatLng[] = [];
  for (let i = 0; i <= steps; i += 1) track.push(destinationPoint(start, bearingDeg, (covered * i) / steps));
  return track;
}

const SCOPE = circleScope(HOME, 3000);

function oneStreet(name: string, lengthMeters: number, bearingDeg = 0) {
  const way = straightWay(1, name, HOME, bearingDeg, lengthMeters);
  const inventory = buildStreetInventory([way], SCOPE);
  return inventory.streets[0];
}

describe("when a street counts as done", () => {
  it("calls a 1.5 km street complete at 90%, where a flat 95% would be brutal", () => {
    const street = oneStreet("Storgatan", 1500);
    const index = buildFamiliarityIndex([runAlong(HOME, 0, 1500, 0.92)]);
    const coverage = computeStreetCoverage(street, index);

    assert.ok(coverage.ratio >= STREET_COMPLETE_RATIO, `expected >=90% run, got ${coverage.ratio}`);
    assert.equal(coverage.complete, true);
  });

  it("leaves a 1.5 km street unfinished at 80%", () => {
    const street = oneStreet("Storgatan", 1500);
    const index = buildFamiliarityIndex([runAlong(HOME, 0, 1500, 0.8)]);
    const coverage = computeStreetCoverage(street, index);

    assert.equal(coverage.complete, false);
    assert.ok(coverage.remainingMeters > 200, `expected ~300 m left, got ${coverage.remainingMeters}`);
  });

  it("completes a 40 m stub the runner plainly ran, where 90% of nothing is unreachable", () => {
    const street = oneStreet("Gränden", 40);
    const coverage = computeStreetCoverage(street, buildFamiliarityIndex([runAlong(HOME, 0, 40, 0.55)]));

    assert.equal(coverage.complete, true, "what is left is a few paces, not a street");
    assert.equal(
      isStreetComplete(40, 22),
      true,
      "18 m short of a stub is the remainder rule's whole reason to exist",
    );
  });

  it("forgives the last 25 m of OSM geometry that runs past where anyone goes", () => {
    assert.equal(isStreetComplete(800, 780), true, "20 m of turning circle does not block a street");
    assert.equal(isStreetComplete(800, 700), false, "100 m left is 100 m left");
    assert.equal(isStreetComplete(0, 0), false, "a street with no length is not an achievement");
  });

  it("gives no credit for a run on the next street over", () => {
    const street = oneStreet("Storgatan", 600);
    const parallel = destinationPoint(HOME, 90, 120);
    const index = buildFamiliarityIndex([runAlong(parallel, 0, 600, 1)]);

    assert.equal(computeStreetCoverage(street, index).coveredMeters < 1, true);
  });

  it("counts a run on one side of a dual carriageway as the street", () => {
    const northbound = straightWay(1, "Kungsvägen", HOME, 0, 900);
    const southbound = straightWay(2, "Kungsvägen", destinationPoint(HOME, 90, 14), 0, 900);
    const street = buildStreetInventory([northbound, southbound], SCOPE).streets[0];
    const index = buildFamiliarityIndex([runAlong(HOME, 0, 900, 1)]);

    assert.equal(computeStreetCoverage(street, index).complete, true);
  });
});

describe("streets that straddle the scope edge require only the part inside", () => {
  it("completes when the in-scope stretch is run and the outside stretch is not", () => {
    const scope = circleScope(HOME, 1000);
    const start = destinationPoint(HOME, 90, 500);
    const street = buildStreetInventory([straightWay(1, "Kantvägen", start, 90, 1500)], scope).streets[0];

    const insideOnly = runAlong(start, 90, 520, 1);
    const coverage = computeStreetCoverage(street, buildFamiliarityIndex([insideOnly]));

    assert.equal(coverage.complete, true, "ground outside the project must never block the project");
  });
});

describe("project progress over a whole town", () => {
  const inventory = buildStreetInventory(falkenbergWays(), circleScope(HOME, 3000));

  it("reads a real inventory and reports both the street and the distance view", () => {
    const streets = inventory.streets.slice(0, 40);
    const history = streets.slice(0, 10).flatMap((street) => street.geometry);
    const coverage = computeProjectCoverage(streets, buildFamiliarityIndex(history));

    assert.equal(coverage.streetsTotal, 40);
    assert.ok(coverage.streetsComplete >= 10, `running 10 whole streets completes them, got ${coverage.streetsComplete}`);
    assert.ok(coverage.ratio > 0.2 && coverage.ratio < 0.9);
    assert.ok(coverage.distanceRatio > 0 && coverage.distanceRatio <= 1);
  });

  it("pre-fills a brand new project from history the runner already has", () => {
    const streets = inventory.streets.slice(0, 60);
    // Every logged run the owner has, not a subset chosen for this project.
    const history = streets.slice(0, 25).flatMap((street) => street.geometry);

    const progress = computeProjectProgress("new-project", streets, history);

    assert.ok(progress.streetsComplete > 0, "a new project never opens at zero when there is history");
    assert.ok(progress.ratio > 0.3, `expected a real head start, got ${progress.ratio}`);
    assert.equal(progress.projectId, "new-project");
  });

  it("is empty, not broken, for a project somewhere the runner has never been", () => {
    const streets = inventory.streets.slice(0, 20);
    const elsewhere = [runAlong({ lat: 50.11, lng: 8.68 }, 0, 2000, 1)];
    const progress = computeProjectProgress("frankfurt", streets, elsewhere);

    assert.equal(progress.streetsComplete, 0);
    assert.equal(progress.ratio, 0);
    assert.equal(progress.streetsTotal, 20);
  });

  it("never lets more coverage lower the score", () => {
    const streets = inventory.streets.slice(0, 30);
    const some = streets.slice(0, 5).flatMap((street) => street.geometry);
    const more = streets.slice(0, 12).flatMap((street) => street.geometry);

    const first = computeProjectCoverage(streets, buildFamiliarityIndex(some));
    const second = computeProjectCoverage(streets, buildFamiliarityIndex(more));

    assert.ok(second.coveredMeters >= first.coveredMeters);
    assert.ok(second.streetsComplete >= first.streetsComplete);
  });
});

describe("the map shows the same line the percentage was computed from", () => {
  it("splits a half-run street into a done half and a left half", () => {
    const street = oneStreet("Halvvägen", 1000);
    const index = buildFamiliarityIndex([runAlong(HOME, 0, 1000, 0.5)]);

    const { covered, missing } = splitStreetByCoverage(street, index);
    const coveredMeters = covered.reduce((sum, piece) => sum + polylineDistanceMeters(piece), 0);
    const missingMeters = missing.reduce((sum, piece) => sum + polylineDistanceMeters(piece), 0);
    const coverage = computeStreetCoverage(street, index);

    assert.ok(Math.abs(coveredMeters - coverage.coveredMeters) < 15, "the drawn line agrees with the number");
    assert.ok(Math.abs(missingMeters - coverage.remainingMeters) < 15);
  });
});
