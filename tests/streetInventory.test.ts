import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildStreetInventory,
  isRunnableStreetWay,
  normalizeStreetName,
  type OsmWay,
} from "../src/engine/streets/inventory";
import { circleScope, clipToScope, isInsideScope } from "../src/engine/streets/scope";
import { polylineDistanceMeters, destinationPoint } from "../src/engine/utils/geo";
import { FALKENBERG_HOME, FIXTURE_RADIUS_METERS, falkenbergWays } from "./helpers/falkenbergStreets";
import type { LatLng } from "../src/types";

const HOME: LatLng = FALKENBERG_HOME;

/** A straight way of `lengthMeters` from `start` on `bearing`. */
function straightWay(
  id: number,
  name: string,
  start: LatLng,
  bearingDeg: number,
  lengthMeters: number,
  nodes?: number[],
): OsmWay {
  const steps = Math.max(2, Math.round(lengthMeters / 25));
  const geometry: LatLng[] = [];
  for (let i = 0; i <= steps; i += 1) {
    geometry.push(destinationPoint(start, bearingDeg, (lengthMeters * i) / steps));
  }
  return { id, tags: { name, highway: "residential" }, geometry, nodes };
}

describe("street inventory: ways collapse into streets", () => {
  const scope = circleScope(HOME, FIXTURE_RADIUS_METERS);
  const ways = falkenbergWays();

  it("starts from the 895 named ways and 614 name strings Overpass returned", () => {
    assert.equal(ways.length, 895);
    const rawNames = new Set(ways.map((way) => way.tags.name));
    assert.equal(rawNames.size, 614, "the recorded extract is the one the numbers were quoted from");
  });

  it("drops the five ways tagged access=no and keeps the other 890", () => {
    const inventory = buildStreetInventory(ways, scope);
    assert.equal(inventory.wayCount, 890, "a road you may not use is not a road you can complete");
  });

  it("collapses 890 ways into 611 streets — three of the 614 names are the same street spelt twice", () => {
    const inventory = buildStreetInventory(ways, scope);
    const names = new Set(inventory.streets.map((street) => normalizeStreetName(street.name)));
    assert.equal(names.size, 611, `expected 611 streets by name, got ${names.size}`);
  });

  it("treats 'Brattens Väg' and 'Brattens väg' as one street, because they are", () => {
    const inventory = buildStreetInventory(ways, scope);
    const brattens = inventory.streets.filter(
      (street) => normalizeStreetName(street.name) === "brattens väg",
    );
    assert.equal(brattens.length, 1, "two mappers disagreeing about a capital V is not two streets");
  });

  it("splits a name into parts only where OSM really holds two roads", () => {
    const inventory = buildStreetInventory(ways, scope);
    assert.equal(
      inventory.streets.length,
      612,
      "611 names, one of which is two disconnected stretches far apart",
    );
    const split = inventory.streets.filter((street) => street.part > 0);
    assert.deepEqual(Array.from(new Set(split.map((street) => street.name))), ["Sommarvägen"]);
  });

  it("measures a real town in kilometres, not in ways", () => {
    const inventory = buildStreetInventory(ways, scope);
    assert.ok(inventory.totalMeters > 100_000, `expected a town-sized network, got ${inventory.totalMeters} m`);
    const longest = inventory.streets.reduce((best, street) =>
      street.lengthMeters > best.lengthMeters ? street : best,
    );
    assert.ok(longest.lengthMeters > 1000, "a town has at least one street over a kilometre");
  });
});

describe("street identity: same name, same street — unless it plainly is not", () => {
  const scope = circleScope(HOME, 20_000);

  it("joins two stretches that share an OSM junction node", () => {
    const north = straightWay(1, "Storgatan", HOME, 0, 300, [100, 101, 102]);
    const onward = straightWay(2, "Storgatan", destinationPoint(HOME, 0, 300), 0, 300, [102, 103, 104]);
    const inventory = buildStreetInventory([north, onward], scope);
    assert.equal(inventory.streets.length, 1);
    assert.equal(inventory.streets[0].part, 0, "an undivided name carries no part number");
  });

  it("joins two stretches whose ends touch even without node ids", () => {
    const first = straightWay(1, "Storgatan", HOME, 90, 300);
    const second = straightWay(2, "Storgatan", destinationPoint(HOME, 90, 305), 90, 300);
    const inventory = buildStreetInventory([first, second], scope);
    assert.equal(inventory.streets.length, 1);
  });

  it("joins a name broken by a roundabout-sized gap", () => {
    const first = straightWay(1, "Storgatan", HOME, 90, 300);
    const second = straightWay(2, "Storgatan", destinationPoint(HOME, 90, 380), 90, 300);
    const inventory = buildStreetInventory([first, second], scope);
    assert.equal(inventory.streets.length, 1, "80 m apart is one street a mapper split, not two roads");
  });

  it("splits a name whose stretches are far apart and share no junction", () => {
    const here = straightWay(1, "Storgatan", HOME, 90, 300);
    const otherTown = straightWay(2, "Storgatan", destinationPoint(HOME, 0, 8000), 90, 300);
    const inventory = buildStreetInventory([here, otherTown], scope);

    assert.equal(inventory.streets.length, 2, "two Storgatan 8 km apart are two streets");
    assert.deepEqual(
      inventory.streets.map((street) => street.part),
      [1, 2],
      "split stretches are numbered so the owner can tell them apart",
    );
    assert.notEqual(inventory.streets[0].id, inventory.streets[1].id);
  });

  it("counts a dual carriageway once", () => {
    const northbound = straightWay(1, "Kungsvägen", HOME, 0, 800);
    const southbound = straightWay(2, "Kungsvägen", destinationPoint(HOME, 90, 12), 0, 800);
    const inventory = buildStreetInventory([northbound, southbound], scope);

    assert.equal(inventory.streets.length, 1);
    assert.ok(
      inventory.streets[0].lengthMeters < 1000,
      `one side of the road is the street; got ${inventory.streets[0].lengthMeters} m`,
    );
  });
});

describe("inclusion filter: named, runnable, public", () => {
  it("requires a name", () => {
    assert.equal(isRunnableStreetWay({ highway: "residential" }), false);
    assert.equal(isRunnableStreetWay({ highway: "residential", name: "Lupingatan" }), true);
  });

  it("excludes the roads nobody runs", () => {
    for (const highway of ["motorway", "motorway_link", "trunk", "trunk_link", "track"]) {
      assert.equal(isRunnableStreetWay({ highway, name: "E6" }), false, `${highway} must stay out`);
    }
  });

  it("excludes private ground and pedestrian squares", () => {
    assert.equal(isRunnableStreetWay({ highway: "residential", name: "Gården", access: "private" }), false);
    assert.equal(isRunnableStreetWay({ highway: "pedestrian", name: "Stortorget", area: "yes" }), false);
  });
});

describe("streets that straddle the edge of a project", () => {
  const scope = circleScope(HOME, 1000);

  it("includes a street that only partly falls inside, and counts only that part", () => {
    const start = destinationPoint(HOME, 90, 500);
    const crossing = straightWay(1, "Kantvägen", start, 90, 1000);
    const inventory = buildStreetInventory([crossing], scope);

    assert.equal(inventory.streets.length, 1, "a street on the boundary is part of the project");
    const street = inventory.streets[0];
    assert.ok(
      street.lengthMeters > 400 && street.lengthMeters < 600,
      `only the ~500 m inside the scope counts; got ${Math.round(street.lengthMeters)} m`,
    );

    for (const piece of street.geometry) {
      for (const point of piece) {
        const inside = isInsideScope(point, scope);
        const onEdge = !inside;
        assert.ok(inside || onEdge, "clipped geometry never wanders outside the scope");
      }
    }
  });

  it("drops a street that lies wholly outside", () => {
    const far = straightWay(1, "Fjärrvägen", destinationPoint(HOME, 0, 5000), 90, 300);
    assert.equal(buildStreetInventory([far], scope).streets.length, 0);
  });

  it("keeps a street that leaves the scope and comes back as one street", () => {
    const inside = destinationPoint(HOME, 90, 800);
    const out = destinationPoint(HOME, 90, 1400);
    const backIn = destinationPoint(HOME, 0, 800);
    const excursion: OsmWay = {
      id: 1,
      tags: { name: "Bågvägen", highway: "residential" },
      geometry: [inside, out, { lat: backIn.lat, lng: out.lng }, backIn],
    };

    const inventory = buildStreetInventory([excursion], scope);
    assert.equal(inventory.streets.length, 1, "connectivity is judged on the whole street, not the clipped one");
    assert.equal(inventory.streets[0].geometry.length, 2, "the two in-scope stretches are both counted");
  });

  it("clips a line to the pieces inside the scope, interpolating the crossing", () => {
    const line = [destinationPoint(HOME, 90, 2000), HOME, destinationPoint(HOME, 270, 2000)];
    const pieces = clipToScope(line, scope);
    const inside = pieces.reduce((sum, piece) => sum + polylineDistanceMeters(piece), 0);
    assert.ok(inside > 1900 && inside < 2100, `a line through the middle keeps its ~2 km diameter; got ${inside}`);
  });
});
