import "./helpers/alias";

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NextRequest } from "next/server";

import { resetRouteCache } from "@/engine/providers/budget";
import { assessLoopShape } from "@/engine/scoring/quality";
import { maxPointGapMeters, polylineDistanceMeters } from "@/engine/utils/geo";
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
  // Routed geometry is cached by waypoint signature so one click cannot pay for
  // the same line twice. Left standing between cases, a route an earlier case
  // proved would answer this one's empty provider, and a refusal would read 200.
  resetRouteCache();
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

  it("never mixes an out-and-back in with the loops", async () => {
    stub = stubOpenRouteService({ geometry: OUT_AND_BACK });

    const result = await roundTrip();

    assert.deepEqual(result.routes, [], "an out-and-back is not a loop and never competes as one");
    assert.ok(result.rejectedCount > 0);
    assert.ok(stub.calls.length > 0, "it must actually have asked before falling back");

    // Held back in its own bucket: available when nothing else is, never before.
    assert.ok(result.outAndBacks.length > 0, "sometimes it is the only thing this start can offer");
  });

  it("keeps an out-and-back only when it is safe and the right length", async () => {
    const tooShort = (() => {
      const out = straightTrack(START, 90, 800, 25);
      return [...out, ...out.slice(0, -1).reverse()];
    })();
    stub = stubOpenRouteService({ geometry: tooShort });

    const result = await roundTrip();

    assert.deepEqual(result.routes, []);
    assert.deepEqual(result.outAndBacks, [], "relaxing the shape does not relax the distance");
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

function suggest(body: Record<string, unknown>) {
  const request = new Request("http://localhost/api/routes/suggest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      distance: TARGET_KM,
      centerLat: START.lat,
      centerLon: START.lng,
      familiarityMode: "mixed",
      tracks: [],
      ...body,
    }),
  });
  return POST(request as unknown as NextRequest);
}

/**
 * "Sometimes an out and back might be the only solution. But hey, then it is
 * ok. But we should always try to avoid it."
 */
describe("POST /api/routes/suggest falls back to an out-and-back, last and labelled", () => {
  it("returns a loop, unflagged, when one exists", async () => {
    stub = stubOpenRouteService({ geometry: PROPER_LOOP });

    const response = await suggest({});
    const data = (await response.json()) as any;

    assert.equal(response.status, 200);
    assert.equal(data.isOutAndBack, false);
    assert.equal(data.isRoundTrip, true);
    assert.equal(data.notice, null, "a plain loop needs no apology");
    assert.equal(data.tier, "loop-round-trip");
  });

  it("returns the out-and-back, flagged and explained, when no loop is possible", async () => {
    stub = stubOpenRouteService({ geometry: OUT_AND_BACK });

    const response = await suggest({});
    const data = (await response.json()) as any;

    assert.equal(response.status, 200, "a there-and-back beats no answer at all");
    assert.equal(data.isOutAndBack, true);
    assert.equal(data.isRoundTrip, false, "it is precisely not a round trip");
    assert.equal(data.tier, "out-and-back");
    assert.match(String(data.notice), /out-and-back/i);
    assert.match(String(data.name), /out & back/i);
    assert.ok(data.coordinates.length > 2);

    // The relaxation is about shape only. It is still a real routed line.
    assert.ok(
      maxPointGapMeters(data.coordinates.map(([lng, lat]: [number, number]) => ({ lat, lng }))) < 40,
      "an out-and-back still has to follow real ways",
    );
  });

  it("prefers the loop while any loop candidate remains", async () => {
    // Both shapes on offer from the same generator: the loop must win, every
    // time, however the scoring falls.
    let call = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      call += 1;
      const geometry = call % 2 === 1 ? OUT_AND_BACK : PROPER_LOOP;
      return new Response(
        JSON.stringify({
          features: [
            {
              geometry: { coordinates: geometry.map((p) => [p.lng, p.lat, 10]) },
              properties: {
                summary: { distance: polylineDistanceMeters(geometry) },
                ascent: 42,
                descent: 42,
                extras: {
                  waytype: { summary: [{ value: 6, distance: 5_000, amount: 100 }] },
                  noise: { summary: [{ value: 2, distance: 5_000, amount: 100 }] },
                },
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof globalThis.fetch;

    try {
      const data = (await (await suggest({})).json()) as any;
      assert.equal(data.isOutAndBack, false, "a loop was available, so a loop is what goes back");
      assert.equal(data.tier, "loop-round-trip");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("labels the fallback for a runner whose history is one dead-end road", async () => {
    stub = stubOpenRouteService({ geometry: OUT_AND_BACK });
    const deadEndRoad = straightTrack(START, 90, 2_500, 25);
    const history = [...deadEndRoad, ...deadEndRoad.slice(0, -1).reverse()].map(
      (point) => [point.lng, point.lat] as [number, number],
    );

    const response = await suggest({ familiarityMode: "familiar", tracks: [history] });
    const data = (await response.json()) as any;

    assert.equal(response.status, 200);
    assert.equal(data.isOutAndBack, true);
    assert.equal(data.tier, "out-and-back");
    assert.equal(data.source, "familiarity-engine-out-and-back");
    assert.match(String(data.notice), /out-and-back/i);
    // He still gets told how much of it he already knows.
    assert.ok(data.familiarity.percent >= 80, `got ${data.familiarity.percent}%`);
  });

  it("still refuses when nothing at all can be routed", async () => {
    stub = stubOpenRouteService({ geometry: PROPER_LOOP, empty: true });

    const response = await suggest({});
    const data = (await response.json()) as { error?: string; coordinates?: unknown };

    assert.equal(response.status, 422);
    assert.equal(data.coordinates, undefined);
  });
});
