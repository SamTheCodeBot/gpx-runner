import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assembleBoundaryRing,
  buildBoundaryCandidateQuery,
  buildStreetQuery,
  parseBoundaryCandidates,
  parseOverpassWays,
} from "../src/engine/streets/overpass";
import { buildStreetInventory } from "../src/engine/streets/inventory";
import { boundaryScope, circleScope, isInsideScope } from "../src/engine/streets/scope";
import { FALKENBERG_HOME } from "./helpers/falkenbergStreets";

describe("what we ask Overpass for", () => {
  const scope = circleScope(FALKENBERG_HOME, 3000);

  it("asks by polygon, so a circle and a boundary are the same question", () => {
    const query = buildStreetQuery(scope);
    assert.match(query, /poly:"/);
    assert.doesNotMatch(query, /around:/);
  });

  it("asks only for named runnable streets, and for the geometry and nodes it needs", () => {
    const query = buildStreetQuery(scope);
    assert.match(query, /\["name"\]/);
    assert.match(query, /residential\|living_street/);
    assert.doesNotMatch(query, /motorway/);
    assert.match(query, /out body geom;/);
  });

  it("keeps the polygon short enough to be polite about", () => {
    const bigRing = circleScope(FALKENBERG_HOME, 12_000, 4000);
    const coordinates = buildStreetQuery(bigRing).match(/poly:"([^"]+)"/)?.[1]?.split(" ") ?? [];
    assert.ok(coordinates.length / 2 <= 180, `thinned to ${coordinates.length / 2} points`);
  });

  it("asks which administrative areas contain a point", () => {
    const query = buildBoundaryCandidateQuery(FALKENBERG_HOME);
    assert.match(query, /is_in\(56\.907000,12\.507200\)/);
    assert.match(query, /"boundary"="administrative"/);
  });
});

describe("reading what Overpass says", () => {
  it("turns ways with geometry into inventory input", () => {
    const payload = {
      elements: [
        {
          type: "way",
          id: 1,
          tags: { highway: "residential", name: "Storgatan" },
          nodes: [10, 11],
          geometry: [
            { lat: 56.9, lon: 12.5 },
            { lat: 56.901, lon: 12.5 },
          ],
        },
        { type: "way", id: 2, tags: { highway: "residential" }, geometry: [{ lat: 56.9, lon: 12.5 }] },
        { type: "node", id: 3 },
      ],
    };

    const ways = parseOverpassWays(payload);
    assert.equal(ways.length, 1, "a one-point way is not a street");
    assert.deepEqual(ways[0].nodes, [10, 11]);
    assert.equal(ways[0].geometry[0].lng, 12.5, "OSM lon becomes lng, once, here");
  });

  it("survives an answer with no elements at all", () => {
    assert.deepEqual(parseOverpassWays({}), []);
    assert.deepEqual(parseOverpassWays(null), []);
    assert.deepEqual(parseBoundaryCandidates("<html>busy</html>"), []);
  });

  it("lists administrative candidates smallest first, without guessing what they mean", () => {
    const candidates = parseBoundaryCandidates({
      elements: [
        { type: "relation", id: 1, tags: { name: "Falkenbergs kommun", admin_level: "7" } },
        { type: "relation", id: 2, tags: { name: "Falkenberg", admin_level: "9", place: "town" } },
        { type: "relation", id: 3, tags: { name: "Hallands län", admin_level: "4" } },
      ],
    });

    assert.deepEqual(
      candidates.map((candidate) => candidate.name),
      ["Falkenberg", "Falkenbergs kommun", "Hallands län"],
    );
    assert.equal(candidates[0].kind, "town");
  });
});

describe("boundary relations become one ring", () => {
  const square = {
    elements: [
      {
        type: "relation",
        id: 99,
        members: [
          // Deliberately out of order and partly reversed, as OSM relations are.
          {
            type: "way",
            role: "outer",
            geometry: [
              { lat: 56.92, lon: 12.52 },
              { lat: 56.92, lon: 12.5 },
            ],
          },
          {
            type: "way",
            role: "outer",
            geometry: [
              { lat: 56.9, lon: 12.5 },
              { lat: 56.9, lon: 12.52 },
            ],
          },
          {
            type: "way",
            role: "outer",
            geometry: [
              { lat: 56.92, lon: 12.5 },
              { lat: 56.9, lon: 12.5 },
            ],
          },
          {
            type: "way",
            role: "outer",
            geometry: [
              { lat: 56.9, lon: 12.52 },
              { lat: 56.92, lon: 12.52 },
            ],
          },
        ],
      },
    ],
  };

  it("stitches members into a closed outline whatever order they arrive in", () => {
    const ring = assembleBoundaryRing(square);
    assert.ok(ring.length >= 4, `expected a ring, got ${ring.length} points`);

    const scope = boundaryScope(ring, { kind: "boundary", osmId: 99, osmType: "relation", name: "Testköping" });
    assert.equal(isInsideScope({ lat: 56.91, lng: 12.51 }, scope), true);
    assert.equal(isInsideScope({ lat: 56.95, lng: 12.51 }, scope), false);
  });

  it("a boundary scope feeds the inventory exactly like a circle does", () => {
    const scope = boundaryScope(assembleBoundaryRing(square), {
      kind: "boundary",
      osmId: 99,
      osmType: "relation",
      name: "Testköping",
    });

    const inventory = buildStreetInventory(
      [
        {
          id: 1,
          tags: { highway: "residential", name: "Mittgatan" },
          geometry: [
            { lat: 56.905, lng: 12.505 },
            { lat: 56.915, lng: 12.505 },
          ],
        },
      ],
      scope,
    );

    assert.equal(inventory.streets.length, 1);
    assert.ok(inventory.streets[0].lengthMeters > 1000);
  });

  it("ignores an answer that is not a relation", () => {
    assert.deepEqual(assembleBoundaryRing({ elements: [] }), []);
  });
});
