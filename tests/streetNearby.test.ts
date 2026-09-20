import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { partitionStreets } from "../src/engine/streets/exclusions";
import type { Street } from "../src/engine/streets/inventory";
import { describeNearby, findNearbyStreets, mergeNearbyStreets } from "../src/engine/streets/nearby";
import { circleScope, growScope, isInsideScope, scopeRadiusMeters } from "../src/engine/streets/scope";
import type { LatLng } from "../src/types";

/**
 * The circle is a guess, and this is how the guess gets corrected without
 * throwing the project away.
 */

const HOME: LatLng = { lat: 56.907, lng: 12.5072 };

function metersEast(from: LatLng, meters: number): LatLng {
  return { lat: from.lat, lng: from.lng + meters / (111_320 * Math.cos((from.lat * Math.PI) / 180)) };
}

function metersNorth(from: LatLng, meters: number): LatLng {
  return { lat: from.lat + meters / 111_320, lng: from.lng };
}

function street(id: string, name: string, start: LatLng, meters: number, part = 0): Street {
  return {
    id,
    name,
    part,
    wayIds: [1],
    geometry: [[start, metersEast(start, meters)]],
    lengthMeters: meters,
  };
}

describe("growing the look, not the project", () => {
  it("grows a circle by exactly the margin", () => {
    const scope = circleScope(HOME, 3000);
    const grown = growScope(scope, 1000);

    assert.ok(Math.abs(scopeRadiusMeters(grown) - 4000) < 20, `radius was ${scopeRadiusMeters(grown)}`);
    // The original is untouched: the denominator stays frozen.
    assert.ok(Math.abs(scopeRadiusMeters(scope) - 3000) < 20);
  });

  it("takes in ground the original area excluded", () => {
    const scope = circleScope(HOME, 3000);
    const justOutside = metersNorth(HOME, 3500);

    assert.equal(isInsideScope(justOutside, scope), false);
    assert.equal(isInsideScope(justOutside, growScope(scope, 1000)), true);
  });

  it("a margin of nothing changes nothing", () => {
    const scope = circleScope(HOME, 3000);
    assert.equal(growScope(scope, 0), scope);
  });

  it("pushes a boundary ring outward too", () => {
    const ring = [
      metersNorth(HOME, 1000),
      metersEast(metersNorth(HOME, 1000), 1000),
      metersEast(HOME, 1000),
      HOME,
    ];
    const scope = { ring, source: { kind: "boundary" as const, osmId: 1, osmType: "relation" as const, name: "Town" } };
    const grown = growScope(scope, 500);

    assert.ok(scopeRadiusMeters(grown) > scopeRadiusMeters(scope) + 400);
    // Still the same boundary, not silently turned into a circle.
    assert.equal(grown.source.kind, "boundary");
    assert.equal(grown.ring.length, scope.ring.length);
  });
});

describe("what the area missed", () => {
  const snapshot = [street("s1", "Storgatan", HOME, 400), street("s2", "Nygatan", metersNorth(HOME, 300), 400)];

  it("offers a street the project has never held", () => {
    const wider = [...snapshot, street("s9", "Utanförgatan", metersNorth(HOME, 4000), 300)];
    const nearby = findNearbyStreets(snapshot, wider);

    assert.deepEqual(
      nearby.additions.map((s) => s.name),
      ["Utanförgatan"],
    );
    assert.equal(nearby.extensions.length, 0);
  });

  it("does not offer back a street already in the project", () => {
    const nearby = findNearbyStreets(snapshot, [...snapshot]);
    assert.equal(nearby.additions.length, 0);
    assert.equal(nearby.extensions.length, 0);
  });

  it("spots a street the circle cut in half", () => {
    // Same street, same place, but the wider read sees all 900 m of it.
    const wider = [street("s1", "Storgatan", HOME, 900), snapshot[1]];
    const nearby = findNearbyStreets(snapshot, wider);

    assert.equal(nearby.additions.length, 0);
    assert.equal(nearby.extensions.length, 1);
    assert.equal(nearby.extensions[0].replacesId, "s1");
    assert.equal(nearby.extensions[0].wasMeters, 400);
    assert.equal(nearby.extensions[0].nowMeters, 900);
  });

  it("ignores the few metres of jitter between two OSM reads", () => {
    const wider = [street("s1", "Storgatan", HOME, 430), snapshot[1]];
    assert.equal(findNearbyStreets(snapshot, wider).extensions.length, 0);
  });
});

describe("letting them in", () => {
  const snapshot = [street("s1", "Storgatan", HOME, 400), street("s2", "Nygatan", metersNorth(HOME, 300), 400)];

  it("appends an addition and keeps the list sorted", () => {
    const addition = street("s9", "Alfagatan", metersNorth(HOME, 4000), 300);
    const merged = mergeNearbyStreets(snapshot, { additions: [addition], extensions: [] });

    assert.equal(merged.length, 3);
    assert.deepEqual(
      merged.map((s) => s.name),
      ["Alfagatan", "Nygatan", "Storgatan"],
    );
  });

  it("an extension replaces the stub without changing its id", () => {
    const fuller = street("different-id", "Storgatan", HOME, 900);
    const merged = mergeNearbyStreets(snapshot, {
      additions: [],
      extensions: [{ street: fuller, replacesId: "s1", wasMeters: 400, nowMeters: 900 }],
    });

    assert.equal(merged.length, 2, "an extension is not a second street");
    const storgatan = merged.find((s) => s.name === "Storgatan");
    assert.equal(storgatan?.id, "s1", "the id the project already knows it by");
    assert.equal(storgatan?.lengthMeters, 900);
  });

  it("an exclusion survives the street being extended", () => {
    // He struck Storgatan off; extending it must not quietly let it back in.
    const fuller = street("different-id", "Storgatan", HOME, 900);
    const merged = mergeNearbyStreets(snapshot, {
      additions: [],
      extensions: [{ street: fuller, replacesId: "s1", wasMeters: 400, nowMeters: 900 }],
    });

    const { active, excluded } = partitionStreets(merged, ["s1"]);
    assert.deepEqual(
      active.map((s) => s.name),
      ["Nygatan"],
    );
    assert.equal(excluded[0].lengthMeters, 900);
  });

  it("adding the same street twice adds it once", () => {
    const addition = street("s9", "Alfagatan", metersNorth(HOME, 4000), 300);
    const once = mergeNearbyStreets(snapshot, { additions: [addition], extensions: [] });
    const twice = mergeNearbyStreets(once, { additions: [addition], extensions: [] });
    assert.equal(twice.length, once.length);
  });
});

describe("saying what is on offer", () => {
  it("counts the streets and the kilometres", () => {
    const nearby = {
      additions: [street("s9", "Utanförgatan", metersNorth(HOME, 4000), 600)],
      extensions: [],
    };
    assert.equal(describeNearby(nearby), "1 street just outside your area · 0.6 km");
  });

  it("says so when there is nothing out there", () => {
    assert.match(describeNearby({ additions: [], extensions: [] }), /Nothing runnable/);
  });
});
