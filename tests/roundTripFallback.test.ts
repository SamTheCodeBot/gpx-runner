import "./helpers/alias";

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NextRequest } from "next/server";

import { assessLoopShape } from "@/engine/scoring/quality";
import { polylineDistanceMeters } from "@/engine/utils/geo";
import type { LatLng } from "@/types";
import { destinationPoint } from "@/engine/utils/geo";
import { radiusForLoopDistance, straightTrack } from "./helpers/geometry";
import { stubOpenRouteService, type OrsStub } from "./helpers/orsStub";

process.env.OPENROUTESERVICE_API_KEY = process.env.OPENROUTESERVICE_API_KEY || "offline-test-stub";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { generateOpenRouteServiceRoundTrip } = require("@/api/routeGeneratorService") as typeof import("@/api/routeGeneratorService");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { POST } = require("@/app/api/routes/suggest/route") as {
  POST: (request: NextRequest) => Promise<Response>;
};

/**
 * "Give the routes some kind of circle. Start at A and come back to A, but no
 * straight line back and forward."
 *
 * The round-trip generator is the fallback, used whenever the familiarity
 * engine has nothing to work with. It applied none of the loop-shape checks,
 * so it was free to answer a request for a loop with an out-and-back — and the
 * fallback is exactly the path a new user hits first.
 */

const START: LatLng = { lat: 56.9, lng: 12.5 };
const TARGET_KM = 5;

/** Straight out for 2.5 km, turn round, straight back. The thing to refuse. */
const OUT_AND_BACK = (() => {
  const out = straightTrack(START, 90, 2_500, 25);
  return [...out, ...out.slice(0, -1).reverse()];
})();

/**
 * What openrouteservice's `round_trip` actually returns: a ring with the
 * runner's start on it, not around it. Using a circle centred on the start
 * would let this test pass while the shipped path rejected every real route.
 */
const PROPER_LOOP = (() => {
  const radius = radiusForLoopDistance(TARGET_KM * 1_000);
  const centre = destinationPoint(START, 0, radius);
  const loop: LatLng[] = [];
  for (let i = 0; i <= 96; i += 1) loop.push(destinationPoint(centre, 180 + (360 / 96) * i, radius));
  return loop;
})();

let stub: OrsStub | null = null;

afterEach(() => {
  stub?.restore();
  stub = null;
});

function roundTrip(overrides: Record<string, unknown> = {}) {
  return generateOpenRouteServiceRoundTrip({
    start: START,
    targetDistanceKm: TARGET_KM,
    toleranceKm: 0.5,
    alternatives: 3,
    ...overrides,
  });
}

describe("the round-trip fallback holds the same loop shape line", () => {
  it("agrees that the fixture really is an out-and-back of the right length", () => {
    const shape = assessLoopShape(OUT_AND_BACK, START, TARGET_KM * 1_000);
    assert.equal(shape.ok, false);
    assert.ok(shape.outAndBackRatio > 0.2, `retraced ${(shape.outAndBackRatio * 100).toFixed(0)}%`);
    // Distance is not the problem here — shape is. Otherwise the rejection
    // below would pass for the wrong reason.
    const fixtureMeters = polylineDistanceMeters(OUT_AND_BACK);
    assert.ok(
      Math.abs(fixtureMeters - TARGET_KM * 1_000) <= 500,
      `fixture is ${fixtureMeters.toFixed(0)} m, which is inside the distance tolerance`,
    );
  });

  it("returns nothing rather than an out-and-back", async () => {
    stub = stubOpenRouteService({ geometry: OUT_AND_BACK });

    const result = await roundTrip();

    assert.deepEqual(result.routes, [], "an out-and-back is not a loop, not even as a closest match");
    assert.ok(result.rejectedCount > 0);
    assert.ok(stub.calls.length > 0, "it must actually have asked before refusing");
  });

  it("still returns a proper loop", async () => {
    stub = stubOpenRouteService({ geometry: PROPER_LOOP });

    const result = await roundTrip();

    assert.ok(result.routes.length > 0, "a real loop of the right length must come through");
    assert.ok(result.routes[0].debug.outAndBackRatio <= 0.2);
    assert.ok(result.routes[0].debug.angularCoverage >= 0.72);
  });

  it("stops at its deadline instead of running on", async () => {
    stub = stubOpenRouteService({ geometry: PROPER_LOOP });

    const result = await roundTrip({ deadlineAt: Date.now() - 1 });

    assert.equal(stub.calls.length, 0, "no provider call may start after the deadline");
    assert.deepEqual(result.routes, []);
  });
});

describe("POST /api/routes/suggest with no usable loop", () => {
  it("refuses with 422 rather than serving an out-and-back", async () => {
    stub = stubOpenRouteService({ geometry: OUT_AND_BACK });

    const request = new Request("http://localhost/api/routes/suggest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        distance: TARGET_KM,
        centerLat: START.lat,
        centerLon: START.lng,
        familiarityMode: "mixed",
        tracks: [],
      }),
    });

    const response = await POST(request as unknown as NextRequest);
    const data = (await response.json()) as { error?: string; coordinates?: unknown };

    assert.equal(response.status, 422);
    assert.equal(data.coordinates, undefined);
    assert.match(String(data.error), /loop/i);
  });
});
