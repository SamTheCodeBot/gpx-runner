import "./helpers/alias";

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";

import type { NextRequest } from "next/server";

import { resetRouteCache } from "@/engine/providers/budget";
import { assessLoopShape } from "@/engine/scoring/quality";
import type { LatLng } from "@/types";
import { FALKENBERG_HOME, buildFalkenbergHistory } from "./helpers/denseHistory";
import { FALKENBERG_ORS_LOOP, FALKENBERG_ORS_LOOP_METERS } from "./helpers/falkenbergOrsLoop";
import { routeAlongGrid } from "./helpers/gridRouter";
import {
  orsErrorResponse,
  orsRouteBody,
  stubOpenRouteServiceWith,
  type OrsCall,
  type OrsStub,
} from "./helpers/orsStub";

process.env.OPENROUTESERVICE_API_KEY = process.env.OPENROUTESERVICE_API_KEY || "offline-test-stub";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { POST } = require("../src/app/api/routes/suggest/route") as {
  POST: (request: NextRequest) => Promise<Response>;
};

/**
 * The outage this suite exists for.
 *
 * A runner in Falkenberg, 156 logged runs and 1,458 km of history, asking his
 * own front door for 4.5 km, mixed familiarity, any surface, quiet roads. Every
 * request came back `NO RUNNABLE ROUTE FOUND — No loop route found from this
 * start point`, for every combination of settings he tried.
 *
 * The suite that shipped it was 78 tests, all green. It never caught this
 * because every one of them handed the engine a *circle*: 48 points off a
 * compass, perfectly round, centred on the runner. A circle passes any
 * roundness test that has ever been written, including the one that was
 * rejecting every real route in production.
 *
 * So the rule here: nothing in this file is a circle. The waypoint routes are
 * walked along a street grid, and the round-trip answer is 154 coordinates of
 * real openrouteservice output from the start point in the report.
 */

const START: LatLng = { lat: 56.9071, lng: 12.5072 };
const TARGET_KM = 4.5;

const HISTORY = buildFalkenbergHistory().map((track) =>
  track.map((point) => [point.lng, point.lat] as [number, number]),
);

/** What openrouteservice answers: grid-following for waypoints, the real loop for `round_trip`. */
function realisticOrs(call: OrsCall): Response {
  if (call.isRoundTrip) {
    return new Response(orsRouteBody(FALKENBERG_ORS_LOOP), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  const waypoints: LatLng[] = (call.body.coordinates as [number, number][]).map(([lng, lat]) => ({
    lat,
    lng,
  }));
  const geometry = routeAlongGrid(waypoints);
  if (geometry.length < 2) {
    return new Response(JSON.stringify({ features: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(orsRouteBody(geometry), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function post(body: Record<string, unknown>): Promise<Response> {
  const request = new Request("http://localhost/api/routes/suggest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(request as unknown as NextRequest);
}

async function postJson(body: Record<string, unknown>): Promise<{ response: Response; data: any }> {
  const response = await post(body);
  return { response, data: (await response.json()) as any };
}

/** The request the runner in the report actually sent. */
function reportedRequest(overrides: Record<string, unknown> = {}) {
  return {
    distance: TARGET_KM,
    centerLat: START.lat,
    centerLon: START.lng,
    familiarityMode: "mixed",
    routeStyle: "mixed",
    preferQuiet: true,
    tracks: HISTORY,
    ...overrides,
  };
}

let stub: OrsStub | null = null;

afterEach(() => {
  stub?.restore();
  stub = null;
  // Routed geometry is cached by waypoint signature so one click cannot pay
  // for the same line twice. Left standing between cases, the route a previous
  // case proved would answer this one's refusal stub, and a 429 would read 200.
  resetRouteCache();
});

describe("the Falkenberg outage", () => {
  it("answers the exact request that returned nothing in production", async () => {
    stub = stubOpenRouteServiceWith(realisticOrs);

    const { response, data } = await postJson(reportedRequest());

    assert.equal(
      response.status,
      200,
      `4.5 km mixed from a dense history must produce a route, got ${response.status}: ${JSON.stringify(data)}`,
    );
    assert.ok(data.coordinates.length > 2, "a route has geometry");
    assert.ok(data.distance > 0);
    // Never unrouted geometry: every answer is drawn by the provider.
    assert.ok(stub.calls.length > 0, "the provider was actually asked");
    // And it has to be the loop he asked for. Under the shipped gate a genuine
    // loop that happened to pass near its own middle was not merely rejected,
    // it was relabelled: `isOutAndBack` is `!loopOk`, so the runner was told he
    // would be returning the way he came along a route that never repeats a
    // metre. Falling through to the bottom tier is the same bug, quieter.
    assert.equal(data.isOutAndBack, false, `answered with tier ${data.tier}`);
    assert.equal(data.isRoundTrip, true);
  });

  it("returns the runner's own ground as a near miss rather than nothing", async () => {
    // Graph loops are stitched together out of the runner's own tracks, so they
    // score close to 100% familiar and miss the mixed band (0.2–0.8) by
    // construction. That is the one soft constraint: the route still comes
    // back, with its true percentage attached.
    stub = stubOpenRouteServiceWith(realisticOrs);

    const { response, data } = await postJson(reportedRequest());

    assert.equal(response.status, 200);
    assert.equal(typeof data.familiarity.percent, "number", "the percentage is measured and reported");
    assert.ok(
      data.tier === "loop-familiarity-matched" || data.tier === "loop-familiarity-missed",
      `the familiarity engine should answer this, got tier ${data.tier} from ${data.source}`,
    );
    assert.equal(data.isOutAndBack, false, "a loop, not a there-and-back");
  });

  it("still answers when the mixed band cannot be hit at all", async () => {
    // Familiar and new ground are the two ends the same pipeline has to cover.
    for (const familiarityMode of ["familiar", "unfamiliar", "mixed"]) {
      stub?.restore();
      stub = stubOpenRouteServiceWith(realisticOrs);

      const { response, data } = await postJson(reportedRequest({ familiarityMode }));
      assert.equal(
        response.status,
        200,
        `${familiarityMode} returned ${response.status}: ${JSON.stringify(data.error ?? "")}`,
      );
      assert.ok(data.coordinates.length > 2);
    }
  });

  it("accepts the real openrouteservice loop the shipped gate refused", () => {
    const shape = assessLoopShape(FALKENBERG_ORS_LOOP, START, TARGET_KM * 1_000);

    assert.equal(shape.ok, true, `a real 4.5 km loop must pass the gate: ${JSON.stringify(shape)}`);
    assert.ok(shape.outAndBackRatio < 0.01, "it retraces none of itself");
    assert.ok(shape.closureErrorMeters < 50, "it comes back to the door");
    // The measurements that condemned it. Both still reported, neither a gate.
    assert.ok(shape.minRadiusRatio < 0.46, "one street does run near the loop's middle");
    assert.ok(shape.angularCoverage < 1, "and it does not cover every bearing");
    assert.ok(Math.abs(FALKENBERG_ORS_LOOP_METERS - 4_534) < 1);
  });
});

describe("when openrouteservice refuses", () => {
  it("reports a rate limit as a rate limit, not as an empty start point", async () => {
    // The failure that is impossible to diagnose from the outside: the free
    // plan allows a limited number of directions calls per minute, one
    // suggestion can spend dozens, and over the limit every call 429s at once.
    // Swallowed, that is indistinguishable from a start point with no loops.
    stub = stubOpenRouteServiceWith(() =>
      orsErrorResponse(429, 6099, "Rate limit exceeded for this API key."),
    );

    const { response, data } = await postJson(reportedRequest());

    assert.equal(response.status, 429);
    assert.match(data.error, /rate-limit/i);
    assert.ok(
      !/from this start point/.test(data.error),
      `a rate limit says nothing about the start point: ${data.error}`,
    );
    assert.equal(data.debug.providerFailureKind, "rate-limited");
    assert.equal(data.debug.providerFailureStatus, 429);
    assert.equal(data.debug.providerFailureCode, 6099);
    assert.equal(data.debug.providerRefused, true);
  });

  it("stops calling once the provider starts rate-limiting", async () => {
    stub = stubOpenRouteServiceWith(() => orsErrorResponse(429, 6099, "Rate limit exceeded."));

    await post(reportedRequest());

    // Three per batch in the engine, two per batch in the round-trip fan-out.
    // Hammering a closed door only digs the limit deeper for the next runner.
    assert.ok(
      stub.calls.length <= 6,
      `should give up almost immediately, made ${stub.calls.length} calls`,
    );
  });

  it("reports a refused key as a server problem, not a routing result", async () => {
    stub = stubOpenRouteServiceWith(() =>
      orsErrorResponse(401, 2099, "Access to this API has been disallowed."),
    );

    const { response, data } = await postJson(reportedRequest());

    assert.equal(response.status, 503);
    assert.match(data.error, /credentials/i);
    assert.equal(data.debug.providerFailureKind, "unauthorized");
  });

  it("keeps the API key out of everything it reports", async () => {
    const key = "secret-key-value-do-not-leak";
    const previous = process.env.OPENROUTESERVICE_API_KEY;
    process.env.OPENROUTESERVICE_API_KEY = key;

    try {
      // A proxy that echoes the request back is the realistic way a key ends up
      // in an error body.
      stub = stubOpenRouteServiceWith(
        () =>
          new Response(`Bad gateway: upstream rejected Authorization: ${key}`, {
            status: 502,
            headers: { "content-type": "text/plain" },
          }),
      );

      const { response, data } = await postJson(reportedRequest());
      const body = JSON.stringify(data);

      assert.equal(response.status, 503);
      assert.ok(!body.includes(key), `the key must never be echoed back: ${body}`);
      assert.match(String(data.debug.providerFailureMessage), /\[redacted\]/);
    } finally {
      process.env.OPENROUTESERVICE_API_KEY = previous;
    }
  });

  it("still says 'no loop from this start point' when that is the truth", async () => {
    // A 200 with no feature is openrouteservice genuinely finding nothing, and
    // the original message is the right one. The distinction is the whole point.
    stub = stubOpenRouteServiceWith(
      () =>
        new Response(JSON.stringify({ features: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const { response, data } = await postJson(reportedRequest());

    assert.equal(response.status, 422);
    assert.match(data.error, /No loop route found from this start point/);
    assert.equal(data.debug.providerRefused, false);
    assert.ok(data.debug.providerFailure_empty > 0, "recorded as empty, not as a refusal");
  });
});

describe("the fixtures themselves", () => {
  it("uses history that is dense enough to matter", () => {
    const points = HISTORY.reduce((sum, track) => sum + track.length, 0);
    assert.ok(HISTORY.length >= 50, `${HISTORY.length} runs`);
    assert.ok(points > 50_000, `${points} points of history`);
    assert.equal(Math.round(FALKENBERG_HOME.lat * 1000), 56_907);
  });

  it("routes waypoints along ways, never as a circle", () => {
    const square = [
      START,
      { lat: START.lat + 0.004, lng: START.lng },
      { lat: START.lat + 0.004, lng: START.lng + 0.006 },
      START,
    ];
    const routed = routeAlongGrid(square);

    assert.ok(routed.length > 50, "a dense line, as a router returns");
    const shape = assessLoopShape(routed, START, 2_000);
    assert.ok(shape.roundness < 0.9, "grid geometry is not a textbook circle");
  });
});
