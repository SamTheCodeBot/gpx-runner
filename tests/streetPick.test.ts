import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildFamiliarityIndex } from "../src/engine/familiarity";
import { describeStreetCoverage } from "../src/engine/streets/coverage";
import { buildStreetInventory, type OsmWay } from "../src/engine/streets/inventory";
import { buildStreetPickIndex, pickStreetAt } from "../src/engine/streets/pick";
import { circleScope } from "../src/engine/streets/scope";
import { destinationPoint } from "../src/engine/utils/geo";
import { FALKENBERG_HOME, falkenbergWays } from "./helpers/falkenbergStreets";
import type { LatLng } from "../src/types";

const HOME: LatLng = FALKENBERG_HOME;
const SCOPE = circleScope(HOME, 3000);

function straightWay(id: number, name: string, start: LatLng, bearingDeg: number, lengthMeters: number): OsmWay {
  const steps = Math.max(2, Math.round(lengthMeters / 20));
  const geometry: LatLng[] = [];
  for (let i = 0; i <= steps; i += 1) geometry.push(destinationPoint(start, bearingDeg, (lengthMeters * i) / steps));
  return { id, tags: { name, highway: "residential" }, geometry };
}

function inventoryOf(...ways: OsmWay[]) {
  return buildStreetInventory(ways, SCOPE).streets;
}

function named(streets: ReturnType<typeof inventoryOf>, id: string | undefined): string | null {
  return streets.find((street) => street.id === id)?.name ?? null;
}

describe("picking the street under a click", () => {
  const streets = inventoryOf(
    straightWay(1, "Storgatan", HOME, 0, 600),
    straightWay(2, "Nygatan", destinationPoint(HOME, 90, 200), 0, 600),
    straightWay(3, "Tvärgatan", HOME, 90, 400),
  );
  const index = buildStreetPickIndex(streets);

  it("names the street a click landed on", () => {
    const onStorgatan = destinationPoint(destinationPoint(HOME, 0, 300), 90, 6);
    const pick = pickStreetAt(onStorgatan, index);

    assert.equal(named(streets, pick?.streetId), "Storgatan");
    assert.ok((pick?.distanceMeters ?? 99) < 10);
  });

  it("takes the nearest street, not the first one filed", () => {
    // 40 m off Nygatan, 160 m off Storgatan: there is a right answer.
    const nearNygatan = destinationPoint(destinationPoint(HOME, 90, 160), 0, 300);
    assert.equal(named(streets, pickStreetAt(nearNygatan, index, 120)?.streetId), "Nygatan");
  });

  it("resolves a junction to the arm the finger was closest to", () => {
    const alongTvargatan = destinationPoint(destinationPoint(HOME, 90, 90), 0, 4);
    assert.equal(named(streets, pickStreetAt(alongTvargatan, index)?.streetId), "Tvärgatan");
  });

  it("returns nothing for a click on open ground, so the map can deselect", () => {
    const field = destinationPoint(HOME, 225, 800);
    assert.equal(pickStreetAt(field, index), null);
  });

  it("honours the tolerance it is given, in both directions", () => {
    const off = destinationPoint(destinationPoint(HOME, 0, 300), 90, 70);

    assert.equal(pickStreetAt(off, index, 25), null, "a precise click 70 m out is not a pick");
    assert.equal(
      named(streets, pickStreetAt(off, index, 120)?.streetId),
      "Storgatan",
      "a zoomed-out tap 70 m out plainly means that street",
    );
  });

  it("searches wide enough for a tolerance larger than one grid cell", () => {
    // The grid is 40 m; a 150 m tolerance must ring out rather than quietly
    // miss the road it is standing next to.
    // West, away from Nygatan: the point of this test is the ring count, not
    // which of two candidates wins.
    const far = destinationPoint(destinationPoint(HOME, 0, 300), 270, 130);
    assert.equal(named(streets, pickStreetAt(far, index, 150)?.streetId), "Storgatan");
  });

  it("cannot pick a street that was not handed to it", () => {
    const onlyTvargatan = buildStreetPickIndex(streets.filter((street) => street.name === "Tvärgatan"));
    const onStorgatan = destinationPoint(destinationPoint(HOME, 0, 300), 90, 6);

    assert.equal(pickStreetAt(onStorgatan, onlyTvargatan, 40), null);
  });

  it("is empty, not broken, for a project with no streets", () => {
    assert.equal(pickStreetAt(HOME, buildStreetPickIndex([]), 100), null);
  });
});

describe("picking across a whole town", () => {
  const streets = buildStreetInventory(falkenbergWays(), circleScope(HOME, 3000)).streets;
  const index = buildStreetPickIndex(streets);

  it("finds every street from a point on its own centreline", () => {
    const sample = streets.slice(0, 120);
    let hits = 0;

    for (const street of sample) {
      const piece = street.geometry.find((part) => part.length >= 2);
      if (!piece) continue;
      const point = piece[Math.floor(piece.length / 2)];
      const pick = pickStreetAt(point, index, 20);
      // A dual carriageway or a street sharing a junction may legitimately
      // resolve to its neighbour; what must never happen is finding nothing.
      if (pick) hits += 1;
    }

    assert.equal(hits, sample.length, "a click on a street always finds a street");
  });

  it("cannot pick a finished street off a map that is only showing unrun ones", () => {
    // The "left to run" view: half the town run, the finished half off the map
    // entirely. Clicking where a finished street used to be must find the
    // nearest unrun street or nothing — never the street that is not drawn.
    const history = streets.slice(0, 60).flatMap((street) => street.geometry);
    const familiar = buildFamiliarityIndex(history);
    const done = new Set(
      streets.filter((street) => describeStreetCoverage(street, familiar).complete).map((street) => street.id),
    );
    assert.ok(done.size > 10, `expected the history to finish streets, got ${done.size}`);

    const unrunIndex = buildStreetPickIndex(streets.filter((street) => !done.has(street.id)));

    for (const street of streets.filter((candidate) => done.has(candidate.id)).slice(0, 40)) {
      const piece = street.geometry.find((part) => part.length >= 2);
      if (!piece) continue;
      const pick = pickStreetAt(piece[Math.floor(piece.length / 2)], unrunIndex, 40);
      if (pick) assert.equal(done.has(pick.streetId), false, "picked a street that is not on the map");
    }
  });

  it("answers a town-sized index fast enough to run on every tap", () => {
    const started = Date.now();
    for (let i = 0; i < 500; i += 1) {
      pickStreetAt(destinationPoint(HOME, i % 360, 200 + (i % 900)), index, 60);
    }
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 1500, `500 picks took ${elapsed} ms — the grid is not being used`);
  });
});
