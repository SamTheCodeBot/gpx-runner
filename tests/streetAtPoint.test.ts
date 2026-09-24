import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { OsmWay } from "../src/engine/streets/inventory";
import {
  buildNamedStreetQuery,
  buildStreetAtPointQuery,
  escapeOverpassLiteral,
} from "../src/engine/streets/overpass";
import { streetAtPoint, wayAtPoint } from "../src/engine/streets/pointStreet";
import type { LatLng } from "../src/types";

/**
 * Pointing at a road: the local answer to "my circle was not perfect".
 *
 * The case that drove it: a tap lands on one OSM way, and an OSM way is a
 * fragment. Adding the fragment would put 80 m of a 900 m street into the
 * project and call it done the moment he crossed the road.
 */

const HOME: LatLng = { lat: 56.907, lng: 12.5072 };

function east(from: LatLng, meters: number): LatLng {
  return { lat: from.lat, lng: from.lng + meters / (111_320 * Math.cos((from.lat * Math.PI) / 180)) };
}

function north(from: LatLng, meters: number): LatLng {
  return { lat: from.lat + meters / 111_320, lng: from.lng };
}

/** One OSM way: a named fragment of a street, as Overpass returns it. */
function way(id: number, name: string, from: LatLng, meters: number, highway = "residential"): OsmWay {
  return {
    id,
    tags: { highway, name },
    geometry: [from, east(from, meters)],
  };
}

describe("the query a tap becomes", () => {
  it("asks around the point, not around the town", () => {
    const query = buildStreetAtPointQuery(HOME, 30);
    assert.match(query, /around:30,56\.907000,12\.507200/);
    assert.match(query, /\["name"\]/);
    assert.match(query, /out body geom;/);
    // A bounding box is what the expensive town-sized query uses.
    assert.doesNotMatch(query, /\(\d+\.\d+,\d+\.\d+,\d+\.\d+,\d+\.\d+\)/);
  });

  it("collects the rest of the street by name, from a box rather than a radius", () => {
    const query = buildNamedStreetQuery(HOME, "Storgatan", 2500);
    assert.match(query, /\["name"="Storgatan"\]/);

    // `around:` makes Overpass measure a distance to every candidate it has
    // selected. Measured on 2026-09-24 the two forms returned an identical
    // answer for Storgatan, the radius in 69 s and 53 s and the box in 1.2 s
    // and 5.7 s — the difference between a tap that lands and a tap that dies
    // inside the request budget. The circle is still applied, in code, by
    // `streetAtPoint`.
    assert.doesNotMatch(query, /around:/);
    assert.match(query, /\(56\.\d+,12\.\d+,56\.\d+,12\.\d+\);/);
  });

  it("escapes a name that would otherwise break the query", () => {
    assert.equal(escapeOverpassLiteral('Rue "du" Test'), 'Rue \\"du\\" Test');
    const query = buildNamedStreetQuery(HOME, 'Odd "Name"', 500);
    assert.match(query, /\\"Name\\"/);
  });

  it("only ever asks for runnable highways", () => {
    const query = buildStreetAtPointQuery(HOME, 30);
    assert.match(query, /residential/);
    assert.doesNotMatch(query, /motorway/);
  });
});

describe("which way is under the finger", () => {
  const ways = [way(1, "Storgatan", HOME, 200), way(2, "Nygatan", north(HOME, 200), 200)];

  it("names the road that was tapped", () => {
    const tapped = wayAtPoint(ways, east(HOME, 100), 30);
    assert.equal(tapped?.name, "Storgatan");
  });

  it("picks the nearer of two parallel roads", () => {
    const tapped = wayAtPoint(ways, east(north(HOME, 190), 100), 40);
    assert.equal(tapped?.name, "Nygatan");
  });

  it("says nothing when the tap is on open ground", () => {
    assert.equal(wayAtPoint(ways, north(HOME, 5000), 30), null);
  });

  it("ignores unnamed ways", () => {
    const unnamed: OsmWay = { id: 9, tags: { highway: "residential" }, geometry: [HOME, east(HOME, 200)] };
    assert.equal(wayAtPoint([unnamed], east(HOME, 100), 30), null);
  });
});

describe("a fragment becomes the whole street", () => {
  it("collapses every way of the name into one street", () => {
    // Storgatan as OSM holds it: chopped at two junctions.
    const fragments = [
      way(1, "Storgatan", HOME, 300),
      way(2, "Storgatan", east(HOME, 300), 300),
      way(3, "Storgatan", east(HOME, 600), 300),
    ];

    const street = streetAtPoint(fragments, east(HOME, 150), { toleranceMeters: 30 });

    assert.equal(street?.name, "Storgatan");
    assert.equal(street?.wayIds.length, 3, "all three fragments, not just the tapped one");
    assert.ok(street!.lengthMeters > 800, `only got ${Math.round(street!.lengthMeters)} m`);
  });

  it("does not weld together two streets that merely share a name", () => {
    // Two Kyrkogatans, one either side of town, far past the split rule.
    const fragments = [
      way(1, "Kyrkogatan", HOME, 200),
      way(2, "Kyrkogatan", north(HOME, 1500), 200),
    ];

    const street = streetAtPoint(fragments, east(HOME, 100), { toleranceMeters: 30 });
    assert.equal(street?.name, "Kyrkogatan");
    assert.ok(street!.lengthMeters < 400, "the far one was welded on");
  });

  it("returns nothing when no runnable street is there", () => {
    const motorway = way(1, "E6", HOME, 400, "motorway");
    assert.equal(streetAtPoint([motorway], east(HOME, 100), { toleranceMeters: 30 }), null);
  });
});
