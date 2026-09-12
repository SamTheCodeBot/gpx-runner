import type { LatLng } from "../../src/types";
import { polylineDistanceMeters } from "../../src/engine/utils/geo";
import { GRID_METERS, latLngToMeters, metersToLatLng } from "./denseHistory";
import { routeAlongGrid } from "./gridRouter";
import { orsRouteBody, stubOpenRouteServiceWith, type OrsStub } from "./orsStub";

/**
 * openrouteservice, answered locally and *counted*.
 *
 * The whole point of this helper is the number. One click on "Generate Route"
 * used to cost 30–38 calls against a free tier that allows ~40 a minute, which
 * is not a tuning problem but a design one — and the only way that stays fixed
 * is if a test fails when it regresses. So this stub answers realistically
 * (waypoint calls are walked over the same street grid the synthetic history
 * was run on, `round_trip` calls come back as a grid loop of about the right
 * length) and records every single request.
 */
export type CountingOrsStub = OrsStub & {
  /** Waypoint directions calls — the familiarity engine's snapping. */
  readonly routeCalls: number;
  /** `round_trip` calls — the fallback generator. */
  readonly roundTripCalls: number;
  readonly totalCalls: number;
};

export function countingOrs(
  options: { roundTripAnswers?: boolean } = {},
): CountingOrsStub {
  const answerRoundTrip = options.roundTripAnswers !== false;

  const stub = stubOpenRouteServiceWith((call) => {
    if (call.isRoundTrip) {
      if (!answerRoundTrip) {
        return new Response(JSON.stringify({ features: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const [lng, lat] = call.body.coordinates[0] as [number, number];
      const length = Number(call.body.options.round_trip.length) || 5_000;
      const seed = Number(call.body.options.round_trip.seed) || 0;
      const geometry = gridRoundTrip({ lat, lng }, length, seed);
      return jsonResponse(orsRouteBody(geometry));
    }

    const coordinates = (call.body.coordinates as [number, number][]).map(([lng, lat]) => ({
      lat,
      lng,
    }));
    const geometry = routeAlongGrid(coordinates);
    if (geometry.length < 2) {
      return jsonResponse(JSON.stringify({ features: [] }));
    }
    return jsonResponse(orsRouteBody(geometry));
  });

  return {
    ...stub,
    get routeCalls() {
      return stub.calls.filter((call) => !call.isRoundTrip).length;
    },
    get roundTripCalls() {
      return stub.calls.filter((call) => call.isRoundTrip).length;
    },
    get totalCalls() {
      return stub.calls.length;
    },
  };
}

function jsonResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * What `round_trip` gives back: a closed loop over the street grid, roughly the
 * requested length, rotated by the seed so different seeds are different runs.
 */
function gridRoundTrip(start: LatLng, lengthMeters: number, seed: number): LatLng[] {
  const side = Math.max(GRID_METERS, Math.round(lengthMeters / 4 / GRID_METERS) * GRID_METERS);
  const rotation = seed % 4;
  const origin = latLngToMeters(start);
  const corners = [
    { x: 0, y: 0 },
    { x: side, y: 0 },
    { x: side, y: side },
    { x: 0, y: side },
  ];
  const ordered = [...corners.slice(rotation), ...corners.slice(0, rotation)];

  const waypoints = [
    start,
    ...ordered.map((corner) => metersToLatLng(origin.x + corner.x, origin.y + corner.y)),
    start,
  ];
  return routeAlongGrid(waypoints);
}

export { polylineDistanceMeters };
