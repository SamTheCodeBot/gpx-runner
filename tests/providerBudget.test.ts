import "./helpers/alias";

import { describe, it, afterEach } from "node:test";

import type { NextRequest } from "next/server";

import { boundTracksNearStart, historyRadiusMeters } from "@/engine/trackHistory";
import { buildFalkenbergHistory, FALKENBERG_HOME } from "./helpers/denseHistory";
import { countingOrs, type CountingOrsStub } from "./helpers/countingOrs";

process.env.OPENROUTESERVICE_API_KEY = process.env.OPENROUTESERVICE_API_KEY || "offline-test-stub";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { POST } = require("../src/app/api/routes/suggest/route") as {
  POST: (request: NextRequest) => Promise<Response>;
};

const TARGET_KM = 5;

const TRACKS = boundTracksNearStart(buildFalkenbergHistory(), FALKENBERG_HOME, {
  radiusMeters: historyRadiusMeters(TARGET_KM),
}).map((track) => track.map((point) => [point.lng, point.lat] as [number, number]));

function post(body: Record<string, unknown>): Promise<Response> {
  const request = new Request("http://localhost/api/routes/suggest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(request as unknown as NextRequest);
}

let stub: CountingOrsStub | null = null;

afterEach(() => {
  stub?.restore();
  stub = null;
});

describe("BASELINE MEASUREMENT", () => {
  for (const mode of ["familiar", "mixed", "unfamiliar"]) {
    it(`measures ${mode} with dense history`, async () => {
      stub = countingOrs();
      const response = await post({
        distance: TARGET_KM,
        centerLat: FALKENBERG_HOME.lat,
        centerLon: FALKENBERG_HOME.lng,
        familiarityMode: mode,
        tracks: TRACKS,
      });
      const data = (await response.json()) as any;
      console.log(
        `[MEASURE] mode=${mode} status=${response.status} tier=${data.tier ?? "-"} ` +
          `route=${stub.routeCalls} roundTrip=${stub.roundTripCalls} total=${stub.totalCalls}`,
      );
    });
  }

  it("measures the worst case: nothing the engine routes is acceptable", async () => {
    // Every waypoint call comes back as a short line, so no tier can accept and
    // the endpoint falls through to the round-trip generator as well.
    const { stubOpenRouteServiceWith, orsRouteBody } = require("./helpers/orsStub");
    const short = [FALKENBERG_HOME, { lat: FALKENBERG_HOME.lat + 0.002, lng: FALKENBERG_HOME.lng }];
    const hostile = stubOpenRouteServiceWith(() =>
      new Response(orsRouteBody(short), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const response = await post({
      distance: TARGET_KM,
      centerLat: FALKENBERG_HOME.lat,
      centerLon: FALKENBERG_HOME.lng,
      familiarityMode: "mixed",
      tracks: TRACKS,
    });
    console.log(
      `[MEASURE] mode=worst-case status=${response.status} total=${hostile.calls.length} ` +
        `roundTrip=${hostile.calls.filter((c: any) => c.isRoundTrip).length}`,
    );
    hostile.restore();
  });

  it("measures new-ground with no history", async () => {
    stub = countingOrs();
    const response = await post({
      distance: TARGET_KM,
      centerLat: FALKENBERG_HOME.lat,
      centerLon: FALKENBERG_HOME.lng,
      familiarityMode: "unfamiliar",
      tracks: [],
    });
    const data = (await response.json()) as any;
    console.log(
      `[MEASURE] mode=new-ground status=${response.status} tier=${data.tier ?? "-"} ` +
        `route=${stub.routeCalls} roundTrip=${stub.roundTripCalls} total=${stub.totalCalls}`,
    );
  });
});
