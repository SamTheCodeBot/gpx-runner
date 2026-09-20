import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildFamiliarityIndex } from "../src/engine/familiarity";
import { computeProjectCoverage } from "../src/engine/streets/coverage";
import {
  applyExclusionChange,
  describeExclusions,
  partitionStreets,
  pruneExclusions,
} from "../src/engine/streets/exclusions";
import type { Street } from "../src/engine/streets/inventory";
import type { LatLng } from "../src/types";

/**
 * Streets a runner has struck off his own project.
 *
 * The rule under test is the one he chose: excluding shrinks the denominator.
 * A project he has edited must be able to reach 100%, or the edit was
 * pointless.
 */

/** A street running due east from a point, roughly `meters` long. */
function street(id: string, name: string, start: LatLng, meters: number): Street {
  const degreesPerMeter = 1 / (111_320 * Math.cos((start.lat * Math.PI) / 180));
  const end = { lat: start.lat, lng: start.lng + meters * degreesPerMeter };
  return {
    id,
    name,
    part: 0,
    wayIds: [Number(id.replace(/\D/g, "")) || 1],
    geometry: [[start, end]],
    lengthMeters: meters,
  };
}

const HOME: LatLng = { lat: 56.907, lng: 12.5072 };

function townOfThree(): Street[] {
  return [
    street("s1", "Storgatan", HOME, 400),
    street("s2", "Nygatan", { lat: HOME.lat + 0.004, lng: HOME.lng }, 400),
    street("s3", "E6 Motorvägen", { lat: HOME.lat + 0.008, lng: HOME.lng }, 400),
  ];
}

/** A track straight down one street, dense enough to cover it end to end. */
function trackAlong(target: Street): LatLng[] {
  const [from, to] = target.geometry[0];
  const points: LatLng[] = [];
  for (let step = 0; step <= 50; step += 1) {
    points.push({
      lat: from.lat + ((to.lat - from.lat) * step) / 50,
      lng: from.lng + ((to.lng - from.lng) * step) / 50,
    });
  }
  return points;
}

describe("partitioning a project by what the owner struck off", () => {
  it("returns the list untouched when nothing is excluded", () => {
    const streets = townOfThree();
    const { active, excluded } = partitionStreets(streets, []);
    assert.equal(active.length, 3);
    assert.deepEqual(excluded, []);
  });

  it("keeps excluded streets whole rather than dropping them", () => {
    const streets = townOfThree();
    const { active, excluded } = partitionStreets(streets, ["s3"]);

    assert.deepEqual(
      active.map((s) => s.id),
      ["s1", "s2"],
    );
    // Whole, with geometry: putting it back must not need a refetch.
    assert.equal(excluded.length, 1);
    assert.equal(excluded[0].name, "E6 Motorvägen");
    assert.equal(excluded[0].geometry.length, 1);
  });

  it("ignores an id the project does not hold", () => {
    const { active, excluded } = partitionStreets(townOfThree(), ["nothing-like-this"]);
    assert.equal(active.length, 3);
    assert.equal(excluded.length, 0);
  });
});

describe("the denominator shrinks", () => {
  it("a project of three streets with one run reads 33%", () => {
    const streets = townOfThree();
    const index = buildFamiliarityIndex([trackAlong(streets[0])]);
    const coverage = computeProjectCoverage(streets, index);

    assert.equal(coverage.streetsTotal, 3);
    assert.equal(coverage.streetsComplete, 1);
    assert.ok(Math.abs(coverage.ratio - 1 / 3) < 0.01, `ratio was ${coverage.ratio}`);
  });

  it("striking off the unrunnable one moves the same run to 50%", () => {
    const streets = townOfThree();
    const index = buildFamiliarityIndex([trackAlong(streets[0])]);
    const { active } = partitionStreets(streets, ["s3"]);
    const coverage = computeProjectCoverage(active, index);

    assert.equal(coverage.streetsTotal, 2);
    assert.equal(coverage.streetsComplete, 1);
    assert.ok(Math.abs(coverage.ratio - 0.5) < 0.01, `ratio was ${coverage.ratio}`);
  });

  it("lets an edited project actually reach 100%", () => {
    const streets = townOfThree();
    // Every street run except the motorway, which he will never run.
    const index = buildFamiliarityIndex([trackAlong(streets[0]), trackAlong(streets[1])]);

    assert.ok(computeProjectCoverage(streets, index).ratio < 1, "should be short of 100 before the edit");

    const { active } = partitionStreets(streets, ["s3"]);
    assert.equal(computeProjectCoverage(active, index).ratio, 1);
  });

  it("the excluded metres leave the distance total too", () => {
    const streets = townOfThree();
    const index = buildFamiliarityIndex([trackAlong(streets[0])]);

    const before = computeProjectCoverage(streets, index).totalMeters;
    const after = computeProjectCoverage(partitionStreets(streets, ["s3"]).active, index).totalMeters;

    assert.ok(after < before, "total metres should fall with the street");
    assert.ok(before - after > 300, `only ${Math.round(before - after)} m came off`);
  });
});

describe("changing what is excluded", () => {
  it("adds, removes, and stays stable whatever order they arrive in", () => {
    const added = applyExclusionChange([], { streetIds: ["s3", "s1"], excluded: true });
    assert.deepEqual(added, ["s1", "s3"]);

    const other = applyExclusionChange([], { streetIds: ["s1", "s3"], excluded: true });
    assert.deepEqual(added, other, "same set, two orders, one document");

    assert.deepEqual(applyExclusionChange(added, { streetIds: ["s1"], excluded: false }), ["s3"]);
  });

  it("never stores the same street twice", () => {
    const once = applyExclusionChange([], { streetIds: ["s3"], excluded: true });
    assert.deepEqual(applyExclusionChange(once, { streetIds: ["s3"], excluded: true }), ["s3"]);
  });

  it("putting back a street that was never out changes nothing", () => {
    assert.deepEqual(applyExclusionChange(["s3"], { streetIds: ["s2"], excluded: false }), ["s3"]);
  });

  it("drops exclusions whose street the snapshot no longer holds", () => {
    // A refresh rewrote the list and the motorway stretch is gone from OSM.
    const survivors = townOfThree().slice(0, 2);
    assert.deepEqual(pruneExclusions(["s1", "s3"], survivors), ["s1"]);
  });

  it("survives a refresh that kept the street", () => {
    assert.deepEqual(pruneExclusions(["s3"], townOfThree()), ["s3"]);
  });
});

describe("saying it back to the owner", () => {
  it("counts the streets and the kilometres taken out", () => {
    const { excluded } = partitionStreets(townOfThree(), ["s2", "s3"]);
    assert.equal(describeExclusions(excluded), "2 streets · 0.8 km");
  });

  it("gets the singular right", () => {
    const { excluded } = partitionStreets(townOfThree(), ["s3"]);
    assert.match(describeExclusions(excluded), /^1 street ·/);
  });
});
