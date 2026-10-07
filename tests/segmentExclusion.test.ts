import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeStreetCoverage } from "../src/engine/streets/coverage";
import { buildFamiliarityIndex } from "../src/engine/familiarity";
import type { Street } from "../src/engine/streets/inventory";

/**
 * A street mostly run, with one bad stretch struck off.
 *
 * This is the shape the live bug report was in: 403 m run, 65 m of a grass
 * verge OSM drew as pavement. The regression this guards is a real one that
 * shipped once — the server decodes a struck-off stretch before handing the
 * project back over HTTP, and the browser decoded it a second time, which
 * silently emptied it. A street that should read 100% after exclusion kept
 * reading its old percentage because the exclusion the server had actually
 * stored never reached the coverage walk at all.
 */
describe("partial street exclusion", () => {
  it("strikes off exactly the missing stretch and leaves the covered part counted", () => {
    const start = { lat: 56.9, lng: 12.5 };
    const end = { lat: 56.9, lng: 12.508 };
    const street: Street = {
      id: "harry-kullmans-vag",
      name: "Harry Kullmans väg",
      part: 0,
      wayIds: [1],
      geometry: [[start, end]],
      lengthMeters: 468,
    };

    const coveredEnd = { lat: 56.9, lng: 12.5 + (12.508 - 12.5) * (403 / 468) };
    const index = buildFamiliarityIndex([[start, coveredEnd]]);

    const before = describeStreetCoverage(street, index);
    assert.ok(before.missingMeters > 0, "there should be something missing before exclusion");
    assert.equal(before.complete, false);

    // Exactly what the client sends: the missing geometry the map just drew.
    const after = describeStreetCoverage(street, index, before.missing);

    assert.ok(after.missingMeters < 5, `expected missing to drop near 0, got ${after.missingMeters}`);
    assert.ok(after.complete, "the street should now read complete");
  });

  it("reads complete, not stuck, when the whole remaining length is struck off", () => {
    const street: Street = {
      id: "test-street",
      name: "Test Street",
      part: 0,
      wayIds: [1],
      geometry: [[{ lat: 57.0, lng: 12.0 }, { lat: 57.0, lng: 12.003 }]],
      lengthMeters: 190,
    };
    const emptyIndex = buildFamiliarityIndex([]);

    const before = describeStreetCoverage(street, emptyIndex);
    const after = describeStreetCoverage(street, emptyIndex, before.missing);

    assert.ok(after.missingMeters < 1);
    assert.equal(after.complete, true, "nothing left to count should read done, not incomplete");
  });
});
