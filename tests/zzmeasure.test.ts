import "./helpers/alias";

import { describe, it, afterEach } from "node:test";

import type { NextRequest } from "next/server";

import { resetRouteCache } from "@/engine/providers/budget";
import type { LatLng } from "@/types";
import { denseFalkenbergTracks, streetOrs } from "./helpers/streetGrid";
import type { OrsStub } from "./helpers/orsStub";

process.env.OPENROUTESERVICE_API_KEY = process.env.OPENROUTESERVICE_API_KEY || "offline-test-stub";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { POST } = require("../src/app/api/routes/suggest/route") as {
  POST: (request: NextRequest) => Promise<Response>;
};

const START: LatLng = { lat: 56.907, lng: 12.5072 };

const HISTORY = denseFalkenbergTracks();

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
  resetRouteCache();
});

describe("MEASURE new ground", () => {
  for (const km of [5.5, 8.5]) {
    it(`at ${km} km`, async () => {
      const counting = streetOrs();
      stub = counting;
      const response = await post({
        distance: km,
        centerLat: START.lat,
        centerLon: START.lng,
        familiarityMode: "unfamiliar",
        routeStyle: "mixed",
        preferQuiet: true,
        tracks: HISTORY,
      });
      const data = (await response.json()) as any;
      // eslint-disable-next-line no-console
      console.log(
        `[MEASURE] ${km}km status=${response.status} tier=${data.tier} percent=${data.familiarity?.percent} ` +
          `dist=${data.distance ? Math.round(data.distance) : "-"} source=${data.source} ` +
          `routeCalls=${counting.routeCalls} roundTrip=${counting.roundTripCalls} error=${data.error ?? "-"}`,
      );
    });
  }
});
