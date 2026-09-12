import "./helpers/alias";

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";

import type { NextRequest } from "next/server";

import { polylineDistanceMeters } from "../src/engine/utils/geo";
import { LatLng } from "../src/types";
import { circleLoop, radiusForLoopDistance } from "./helpers/geometry";
import { resetRouteCache } from "../src/engine/providers/budget";
import { stubOpenRouteService, type OrsStub } from "./helpers/orsStub";

// The endpoint reads the key only to decide whether it is configured; the stub
// answers every request, so this value is never sent anywhere real.
process.env.OPENROUTESERVICE_API_KEY = process.env.OPENROUTESERVICE_API_KEY || "offline-test-stub";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { POST } = require("../src/app/api/routes/suggest/route") as {
  POST: (request: NextRequest) => Promise<Response>;
};

const START: LatLng = { lat: 56.9, lng: 12.5 };
const TARGET_KM = 5;
const LOOP = circleLoop(START, radiusForLoopDistance(TARGET_KM * 1000));
const LOOP_COORDS = LOOP.map((point) => [point.lng, point.lat] as [number, number]);

async function postJson(body: Record<string, unknown>): Promise<{ response: Response; data: any }> {
  const response = await post(body);
  return { response, data: (await response.json()) as any };
}

function post(body: Record<string, unknown>): Promise<Response> {
  const request = new Request("http://localhost/api/routes/suggest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(request as unknown as NextRequest);
}

let stub: OrsStub | null = null;

afterEach(() => {
  stub?.restore();
  stub = null;
  // Routed geometry is cached by waypoint signature so one click cannot pay for
  // the same line twice. Left standing between cases, a route an earlier case
  // proved would answer this one's refusal stub and a 429 would read as 200.
  resetRouteCache();
});

describe("POST /api/routes/suggest", () => {
  it("runs the familiarity engine and reports a familiar route", async () => {
    stub = stubOpenRouteService({ geometry: LOOP });

    const { response, data } = await postJson({
      distance: TARGET_KM,
      centerLat: START.lat,
      centerLon: START.lng,
      familiarityMode: "familiar",
      tracks: [LOOP_COORDS],
    });

    assert.equal(response.status, 200);
    assert.equal(data.source, "familiarity-engine");
    assert.equal(data.familiarity.withinTarget, true);
    assert.ok(data.familiarity.percent >= 80, `expected >= 80%, got ${data.familiarity.percent}`);
    assert.ok(data.coordinates.length > 2);
    assert.ok(Math.abs(data.distance - polylineDistanceMeters(LOOP)) < 1);
    assert.equal(data.elevationGain, 42);
    // Waypoint requests, not round_trip — round_trip cannot steer familiarity.
    assert.ok(stub.calls.length > 0);
    assert.ok(stub.calls.every((call) => !call.isRoundTrip));
  });

  it("asks openrouteservice for the extras road avoidance needs", async () => {
    stub = stubOpenRouteService({ geometry: LOOP });

    await post({
      distance: TARGET_KM,
      centerLat: START.lat,
      centerLon: START.lng,
      familiarityMode: "familiar",
      tracks: [LOOP_COORDS],
      routeStyle: "trail",
      preferQuiet: true,
      preferGreen: true,
    });

    const [call] = stub.calls;
    assert.deepEqual(call.body.extra_info, ["waytype", "noise"]);
    assert.deepEqual(call.body.options.profile_params.weightings, { quiet: 1, green: 1 });
    assert.ok(call.url.includes("foot-hiking"), `trail should use foot-hiking, got ${call.url}`);
  });

  it("says the band is out of reach rather than offering a different run", async () => {
    stub = stubOpenRouteService({ geometry: LOOP });

    const { response, data } = await postJson({
      distance: TARGET_KM,
      centerLat: START.lat,
      centerLon: START.lng,
      familiarityMode: "unfamiliar",
      tracks: [LOOP_COORDS],
    });

    // Asked for 20% or less; every loop here is ground he has run before. That
    // is not a near miss, it is a different run, and handing it over as the
    // answer is what wasted an afternoon. Say so, and still show the number.
    assert.equal(response.status, 422);
    assert.equal(data.familiarity.withinTarget, false);
    assert.equal(data.familiarity.bandReachable, false);
    assert.ok(data.familiarity.percent >= 80);
    assert.match(data.error, /outside what you asked for/);
    assert.equal(data.coordinates, undefined, "no route is offered when the band is unreachable");
  });

  it("falls back to round_trip when the runner has no history near the start", async () => {
    stub = stubOpenRouteService({ geometry: LOOP });

    const { response, data } = await postJson({
      distance: TARGET_KM,
      centerLat: START.lat,
      centerLon: START.lng,
      familiarityMode: "familiar",
      tracks: [],
    });

    assert.equal(response.status, 200);
    assert.equal(data.source, "openrouteservice-round-trip");
    assert.equal(data.familiarity.percent, null);
    assert.equal(data.familiarity.hasHistory, false);
    assert.match(data.familiarity.message, /could not be measured/);
    assert.ok(stub.calls.every((call) => call.isRoundTrip));
  });

  it("ignores logged runs that are nowhere near the start point", async () => {
    stub = stubOpenRouteService({ geometry: LOOP });
    const faraway = circleLoop({ lat: 57.9, lng: 14.5 }, 800).map(
      (point) => [point.lng, point.lat] as [number, number],
    );

    const { response, data } = await postJson({
      distance: TARGET_KM,
      centerLat: START.lat,
      centerLon: START.lng,
      familiarityMode: "mixed",
      tracks: [faraway],
    });

    assert.equal(data.source, "openrouteservice-round-trip");
    assert.equal(data.familiarity.hasHistory, false);
  });

  it("still accepts the legacy avoidFamiliar/existingRoutes request shape", async () => {
    stub = stubOpenRouteService({ geometry: LOOP });

    const { response, data } = await postJson({
      distance: TARGET_KM,
      centerLat: START.lat,
      centerLon: START.lng,
      avoidFamiliar: true,
      existingRoutes: [{ coordinates: LOOP_COORDS }],
    });

    // The legacy shape maps avoidFamiliar:true onto the unfamiliar target, and
    // this history cannot reach it — so the refusal is the correct answer. What
    // is under test is that the old field names were understood at all.
    assert.equal(response.status, 422);
    assert.equal(data.familiarity.target, "unfamiliar");
    assert.ok(data.familiarity.percent >= 80);
  });

  it("rejects malformed requests", async () => {
    const { response, data } = await postJson({ centerLat: START.lat, centerLon: START.lng });
    assert.equal(response.status, 400);
  });

  it("reports 422 when no loop can be built at all", async () => {
    stub = stubOpenRouteService({ geometry: LOOP, empty: true });

    const response = await post({
      distance: TARGET_KM,
      centerLat: START.lat,
      centerLon: START.lng,
      familiarityMode: "familiar",
      tracks: [LOOP_COORDS],
    });

    assert.equal(response.status, 422);
  });

  it("says so plainly when the server has no openrouteservice key", async () => {
    const key = process.env.OPENROUTESERVICE_API_KEY;
    delete process.env.OPENROUTESERVICE_API_KEY;
    try {
      const { response, data } = await postJson({
        distance: TARGET_KM,
        centerLat: START.lat,
        centerLon: START.lng,
        familiarityMode: "familiar",
        tracks: [LOOP_COORDS],
      });

      assert.equal(response.status, 503);
      assert.match(data.error, /not configured/);
    } finally {
      process.env.OPENROUTESERVICE_API_KEY = key;
    }
  });
});
