import { LatLng } from "../../src/types";
import { polylineDistanceMeters } from "../../src/engine/utils/geo";

/**
 * Stands in for openrouteservice so the suggestion endpoint can be exercised
 * end to end without a key and without the network. It answers both request
 * shapes the app makes: a waypoint route and a `round_trip`.
 */

export type OrsCall = {
  url: string;
  body: any;
  isRoundTrip: boolean;
};

export type OrsStub = {
  calls: OrsCall[];
  restore: () => void;
};

/** A geojson directions response, shaped the way openrouteservice shapes one. */
export function orsRouteBody(
  geometry: LatLng[],
  extras?: {
    waytype?: Array<{ value: number; distance: number; amount: number }>;
    noise?: Array<{ value: number; distance: number; amount: number }>;
  },
): string {
  const distance = polylineDistanceMeters(geometry);
  return JSON.stringify({
    features: [
      {
        geometry: {
          coordinates: geometry.map((point) => [point.lng, point.lat, point.elevation ?? 10]),
        },
        properties: {
          summary: { distance },
          ascent: 42,
          descent: 42,
          extras: {
            waytype: { summary: extras?.waytype ?? [{ value: 6, distance, amount: 100 }] },
            noise: { summary: extras?.noise ?? [{ value: 2, distance, amount: 100 }] },
          },
        },
      },
    ],
  });
}

/**
 * openrouteservice, answered by the test itself.
 *
 * The handler sees each request and returns the whole `Response`, so a test can
 * route realistically, refuse with a 429, or answer a waypoint call differently
 * from a `round_trip`. `stubOpenRouteService` is the fixed-geometry shorthand
 * over the top of it.
 */
export function stubOpenRouteServiceWith(
  handler: (call: OrsCall) => Response | Promise<Response>,
): OrsStub {
  const originalFetch = globalThis.fetch;
  const calls: OrsCall[] = [];

  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const call: OrsCall = { url, body, isRoundTrip: Boolean(body?.options?.round_trip) };
    calls.push(call);
    return handler(call);
  }) as typeof globalThis.fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

/** A refusal from openrouteservice, in its own error envelope. */
export function orsErrorResponse(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function stubOpenRouteService(options: {
  geometry: LatLng[];
  waytype?: Array<{ value: number; distance: number; amount: number }>;
  noise?: Array<{ value: number; distance: number; amount: number }>;
  /** Return no route at all, to exercise the empty paths. */
  empty?: boolean;
}): OrsStub {
  const originalFetch = globalThis.fetch;
  const calls: OrsCall[] = [];
  const distance = polylineDistanceMeters(options.geometry);

  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, body, isRoundTrip: Boolean(body?.options?.round_trip) });

    if (options.empty) {
      return new Response(JSON.stringify({ features: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        features: [
          {
            geometry: {
              coordinates: options.geometry.map((point) => [point.lng, point.lat, point.elevation ?? 10]),
            },
            properties: {
              summary: { distance },
              ascent: 42,
              descent: 42,
              extras: {
                waytype: { summary: options.waytype ?? [{ value: 6, distance, amount: 100 }] },
                noise: { summary: options.noise ?? [{ value: 2, distance, amount: 100 }] },
              },
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}
