import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildFamiliarityIndex } from "../src/engine/familiarity";
import { computeProjectCoverage } from "../src/engine/streets/coverage";
import { buildStreetInventory, type OsmWay } from "../src/engine/streets/inventory";
import { circleScope } from "../src/engine/streets/scope";
import {
  adoptStreets,
  describeInventoryDiff,
  diffInventories,
  makeSnapshot,
} from "../src/engine/streets/snapshot";
import { chunkStreets, decodeStreets, encodeScope, decodeScope, encodeStreets } from "../src/engine/streets/serialize";
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

/** The town as it was when the project was created. */
const originalWays = [
  straightWay(1, "Storgatan", HOME, 0, 800),
  straightWay(2, "Hamngatan", destinationPoint(HOME, 90, 300), 0, 600),
  straightWay(3, "Skolgatan", destinationPoint(HOME, 90, 600), 0, 400),
];

/** The same town after a new estate near Hjortsberg was mapped. */
const laterWays = [
  ...originalWays,
  straightWay(4, "Lupingatan", destinationPoint(HOME, 180, 900), 90, 300),
  straightWay(5, "Vallmogatan", destinationPoint(HOME, 180, 1000), 90, 300),
];

describe("the denominator is a snapshot, not a live recount", () => {
  const original = buildStreetInventory(originalWays, SCOPE).streets;
  const later = buildStreetInventory(laterWays, SCOPE).streets;

  it("finds what OSM gained without touching the project", () => {
    const diff = diffInventories(original, later);

    assert.equal(diff.added.length, 2);
    assert.deepEqual(diff.added.map((street) => street.name).sort(), ["Lupingatan", "Vallmogatan"]);
    assert.equal(diff.removed.length, 0);
    assert.equal(diff.unchangedCount, 3);
  });

  it("keeps the percentage the runner earned while new streets sit unadopted", () => {
    const history = original.slice(0, 2).flatMap((street) => street.geometry);
    const index = buildFamiliarityIndex(history);

    const snapshot = makeSnapshot(original);
    const before = computeProjectCoverage(snapshot.streets, index);

    // OSM has moved on; the project has not been told to care yet.
    const diff = diffInventories(snapshot.streets, later);
    const afterRefresh = computeProjectCoverage(snapshot.streets, index);

    assert.equal(diff.added.length, 2);
    assert.equal(afterRefresh.streetsTotal, before.streetsTotal, "a refresh alone never moves the goalposts");
    assert.equal(afterRefresh.ratio, before.ratio);
    assert.ok(before.ratio > 0.5);
  });

  it("moves the number only when the owner adopts the new streets", () => {
    const history = original.slice(0, 2).flatMap((street) => street.geometry);
    const index = buildFamiliarityIndex(history);

    const snapshot = makeSnapshot(original);
    const diff = diffInventories(snapshot.streets, later);
    const adopted = adoptStreets(snapshot, diff.added);

    const before = computeProjectCoverage(snapshot.streets, index);
    const after = computeProjectCoverage(adopted.streets, index);

    assert.equal(adopted.streets.length, 5);
    assert.ok(after.ratio < before.ratio, "the honest consequence of a bigger town");
    assert.ok(adopted.totalMeters > snapshot.totalMeters);
  });

  it("says what changed and names the streets, rather than moving a bar", () => {
    const diff = diffInventories(original, later);
    const sentence = describeInventoryDiff(diff);

    assert.match(sentence, /2 new streets/);
    assert.match(sentence, /Lupingatan/);
    assert.match(sentence, /Vallmogatan/);
  });

  it("reports a quiet month as quiet", () => {
    const diff = diffInventories(original, original);
    assert.equal(diff.added.length, 0);
    assert.match(describeInventoryDiff(diff), /has not changed/);
  });

  it("notices a street that has left OSM without deleting anything", () => {
    const diff = diffInventories(original, later.filter((street) => street.name !== "Skolgatan"));

    assert.deepEqual(diff.removed.map((street) => street.name), ["Skolgatan"]);
    assert.match(describeInventoryDiff(diff), /no longer in OSM/);
  });

  it("does not mistake a street that merely grew for a new one", () => {
    const extended = buildStreetInventory(
      [straightWay(1, "Storgatan", HOME, 0, 1100), ...originalWays.slice(1)],
      SCOPE,
    ).streets;

    const diff = diffInventories(original, extended);
    assert.equal(diff.added.length, 0, "a mapper extending a cul-de-sac is not a new street");
    assert.equal(diff.removed.length, 0);
  });
});

describe("a snapshot survives storage", () => {
  const inventory = buildStreetInventory(falkenbergWays(), circleScope(HOME, 3000));

  it("round-trips a real town through the wire form within a metre", () => {
    const restored = decodeStreets(encodeStreets(inventory.streets));

    assert.equal(restored.length, inventory.streets.length);
    const originalMeters = inventory.totalMeters;
    const restoredMeters = restored.reduce((sum, street) => sum + street.lengthMeters, 0);
    assert.ok(Math.abs(originalMeters - restoredMeters) < originalMeters * 0.001);
    assert.deepEqual(restored[0].id, inventory.streets[0].id);
  });

  it("round-trips the scope, circle and all", () => {
    const restored = decodeScope(encodeScope(SCOPE));
    assert.equal(restored.ring.length, SCOPE.ring.length);
    assert.deepEqual(restored.source, SCOPE.source);
  });

  it("splits a town into documents Firestore will accept", () => {
    const chunks = chunkStreets(encodeStreets(inventory.streets));
    assert.ok(chunks.length >= 1);

    for (const chunk of chunks) {
      assert.ok(JSON.stringify(chunk).length < 1_000_000, "a chunk must fit one Firestore document");
    }
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    assert.equal(total, inventory.streets.length, "no street is lost in chunking");
  });
});
