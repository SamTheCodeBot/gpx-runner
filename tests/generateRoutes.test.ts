import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { generateRoutes } from "../src/engine/generateRoute";
import { WAYTYPE } from "../src/engine/scoring/traffic";
import { polylineDistanceMeters } from "../src/engine/utils/geo";
import { LatLng, RouteProvider, RouteProviderExtras } from "../src/types";
import { circleLoop, radiusForLoopDistance } from "./helpers/geometry";

const START: LatLng = { lat: 56.9, lng: 12.5 };
const TARGET_KM = 5;
const LOOP = circleLoop(START, radiusForLoopDistance(TARGET_KM * 1000));
const LOOP_METERS = polylineDistanceMeters(LOOP);

/**
 * A provider that always returns the same loop, so the only thing under test is
 * how the engine judges it. No network — these tests run without an ORS key.
 */
function fixedProvider(extras?: RouteProviderExtras): RouteProvider & { calls: number } {
  const provider = {
    calls: 0,
    async route() {
      provider.calls += 1;
      return {
        geometry: LOOP,
        distanceMeters: LOOP_METERS,
        elevationGainMeters: 42,
        extras,
      };
    },
  };
  return provider;
}

const quietExtras: RouteProviderExtras = {
  waytype: [
    { value: WAYTYPE.cycleway, distance: LOOP_METERS * 0.7, amount: 70 },
    { value: WAYTYPE.footway, distance: LOOP_METERS * 0.3, amount: 30 },
  ],
  noise: [{ value: 2, distance: LOOP_METERS, amount: 100 }],
};

const stateRoadExtras: RouteProviderExtras = {
  waytype: [
    { value: WAYTYPE.stateRoad, distance: 900, amount: 18 },
    { value: WAYTYPE.street, distance: LOOP_METERS - 900, amount: 82 },
  ],
  noise: [{ value: 9, distance: 900, amount: 18 }, { value: 3, distance: LOOP_METERS - 900, amount: 82 }],
};

describe("generateRoutes familiarity band selection", () => {
  it("accepts a loop the runner already knows when asked for a familiar route", async () => {
    const result = await generateRoutes(fixedProvider(quietExtras), {
      start: START,
      targetDistanceKm: TARGET_KM,
      familiarityMode: "familiar",
      routeCollections: [LOOP],
    });

    assert.ok(result.routes.length > 0, "expected at least one familiar route");
    const [best] = result.routes;
    assert.ok(best.familiarityRatio >= 0.8, `expected >= 0.8, got ${best.familiarityRatio}`);
    assert.equal(best.familiarityMeasured, true);
    assert.equal(best.elevationGainMeters, 42);
  });

  it("refuses that same loop when asked for an unfamiliar route, but reports the closest match", async () => {
    const result = await generateRoutes(fixedProvider(quietExtras), {
      start: START,
      targetDistanceKm: TARGET_KM,
      familiarityMode: "new",
      routeCollections: [LOOP],
    });

    assert.equal(result.routes.length, 0, "a fully known loop must not pass as unfamiliar");
    assert.ok(result.nearMisses.length > 0, "expected a near miss to report back to the user");
    assert.ok(result.nearMisses[0].familiarityRatio >= 0.8);
  });

  it("accepts a loop on ground the runner has never covered when asked for an unfamiliar route", async () => {
    const elsewhere = circleLoop({ lat: 57.4, lng: 13.4 }, radiusForLoopDistance(4_000));
    const result = await generateRoutes(fixedProvider(quietExtras), {
      start: START,
      targetDistanceKm: TARGET_KM,
      familiarityMode: "new",
      routeCollections: [elsewhere],
    });

    assert.ok(result.routes.length > 0, "expected an unfamiliar route");
    assert.equal(result.routes[0].familiarityRatio, 0);
  });

  it("accepts a fully known loop for a mixed request only if it is under 80%", async () => {
    const result = await generateRoutes(fixedProvider(quietExtras), {
      start: START,
      targetDistanceKm: TARGET_KM,
      familiarityMode: "mixed",
      routeCollections: [LOOP],
    });

    assert.equal(result.routes.length, 0);
    assert.ok(result.nearMisses.length > 0);
  });

  it("does not claim a measured familiarity when the runner has no history", async () => {
    const result = await generateRoutes(fixedProvider(quietExtras), {
      start: START,
      targetDistanceKm: TARGET_KM,
      familiarityMode: "familiar",
      routeCollections: [],
    });

    assert.ok(result.routes.length > 0);
    assert.equal(result.routes[0].familiarityMeasured, false);
  });
});

describe("generateRoutes road avoidance", () => {
  it("rejects a loop that runs along a state road", async () => {
    const result = await generateRoutes(fixedProvider(stateRoadExtras), {
      start: START,
      targetDistanceKm: TARGET_KM,
      familiarityMode: "familiar",
      routeCollections: [LOOP],
    });

    assert.equal(result.routes.length, 0, "state-road loop must not be suggested");
    assert.ok(result.unsafeRejectedCount > 0);
    assert.equal(result.nearMisses.length, 0, "an unsafe route is not a near miss");
  });

  it("keeps the state-road loop when road avoidance is explicitly disabled", async () => {
    const result = await generateRoutes(fixedProvider(stateRoadExtras), {
      start: START,
      targetDistanceKm: TARGET_KM,
      familiarityMode: "familiar",
      routeCollections: [LOOP],
      avoidUnsafeRoads: false,
    });

    assert.ok(result.routes.length > 0);
    assert.equal(result.routes[0].traffic?.unsafeRoads, true);
  });

  it("scores a quiet loop higher than the same loop along busy roads", async () => {
    const busyExtras: RouteProviderExtras = {
      waytype: [{ value: WAYTYPE.road, distance: LOOP_METERS, amount: 100 }],
      noise: [{ value: 5, distance: LOOP_METERS, amount: 100 }],
    };

    const quiet = await generateRoutes(fixedProvider(quietExtras), {
      start: START,
      targetDistanceKm: TARGET_KM,
      familiarityMode: "familiar",
      routeCollections: [LOOP],
    });
    const busy = await generateRoutes(fixedProvider(busyExtras), {
      start: START,
      targetDistanceKm: TARGET_KM,
      familiarityMode: "familiar",
      routeCollections: [LOOP],
    });

    assert.ok(quiet.routes.length > 0 && busy.routes.length > 0);
    assert.ok(
      quiet.routes[0].score > busy.routes[0].score,
      `quiet ${quiet.routes[0].score} should beat busy ${busy.routes[0].score}`,
    );
  });

  it("passes the runner's road/trail preference to the provider", async () => {
    const seen: Array<string | undefined> = [];
    const provider: RouteProvider = {
      async route(input) {
        seen.push(input.routeStyle);
        return { geometry: LOOP, distanceMeters: LOOP_METERS, extras: quietExtras };
      },
    };

    await generateRoutes(provider, {
      start: START,
      targetDistanceKm: TARGET_KM,
      familiarityMode: "familiar",
      routeCollections: [LOOP],
      routeStyle: "trail",
    });

    assert.ok(seen.length > 0);
    assert.ok(seen.every((style) => style === "trail"));
  });
});
