import type { LatLng } from "../../src/types";
import { polylineDistanceMeters } from "../../src/engine/utils/geo";
import { FALKENBERG_HOME, latLngToMeters, metersToLatLng } from "./denseHistory";
import { orsRouteBody, stubOpenRouteServiceWith, type OrsStub } from "./orsStub";

/**
 * A street network that a router can actually follow, and a history run on it.
 *
 * `denseHistory` + `gridRouter` model a strictly four-connected grid, where any
 * path between two points costs `|dx| + |dy|` — about 27% more than the straight
 * line, whatever order the moves are made in. That is fine for the shape and
 * budget tests they were written for, but it makes every routed loop a quarter
 * longer than the loop that was proposed, so nothing ever clears the ±500 m
 * distance gate and familiarity can never be measured end to end.
 *
 * Real streets are not Manhattan. This grid adds the diagonals, which puts the
 * routed length within a few percent of the proposal — close enough that the
 * suggestion endpoint answers, and familiarity becomes a number a test can hold
 * the engine to.
 *
 * The history is run on the *same* streets, so "familiar" means the runner
 * really has been down that way, not that two fixtures happen to disagree about
 * where the roads are.
 */

export const STREET_METERS = 100;

/** The real numbers from the report: 156 logged runs, 1,458 km, one front door. */
export const DENSE_RUNS = 156;
export const DENSE_TOTAL_KM = 1458;

/**
 * Runners are creatures of habit: a handful of ways out of the door get used
 * over and over, and the ground between them stays unrun. Without that the
 * history is an isotropic blob and every bearing is equally known, which is not
 * a fixture, it is an assumption that the thing under test cannot matter.
 */
const USUAL_BEARINGS = [15, 85, 165, 245, 310];
const HABIT_STRENGTH = 0.72;

type Cell = { x: number; y: number };

const STEPS: Cell[] = [
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: 0 },
  { x: -1, y: -1 },
  { x: 0, y: -1 },
  { x: 1, y: -1 },
];

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Index of the eight-way step closest to a compass bearing. */
function stepTowardBearing(bearingDegrees: number): number {
  // Compass bearing 0 = north = +y, 90 = east = +x.
  const radians = (bearingDegrees * Math.PI) / 180;
  const x = Math.sin(radians);
  const y = Math.cos(radians);
  let best = 0;
  let bestDot = -Infinity;

  for (let i = 0; i < STEPS.length; i += 1) {
    const length = Math.hypot(STEPS[i].x, STEPS[i].y);
    const dot = (STEPS[i].x * x + STEPS[i].y * y) / length;
    if (dot > bestDot) {
      bestDot = dot;
      best = i;
    }
  }

  return best;
}

function sampleAlong(from: LatLng, to: LatLng, out: LatLng[]): void {
  for (let s = 1; s <= 10; s += 1) {
    out.push({
      lat: from.lat + ((to.lat - from.lat) * s) / 10,
      lng: from.lng + ((to.lng - from.lng) * s) / 10,
    });
  }
}

function buildRun(seed: number, targetMeters: number): LatLng[] {
  const rand = mulberry32(seed);
  const habit = USUAL_BEARINGS[Math.floor(rand() * USUAL_BEARINGS.length) % USUAL_BEARINGS.length];
  const preferred = stepTowardBearing(habit + (rand() - 0.5) * 24);

  const out: LatLng[] = [metersToLatLng(0, 0)];
  let x = 0;
  let y = 0;
  let covered = 0;

  while (covered < targetMeters / 2) {
    const drift = Math.floor(rand() * 3) - 1; // stay on the habit, or one notch off it
    const index = rand() < HABIT_STRENGTH ? (preferred + drift + 8) % 8 : Math.floor(rand() * 8) % 8;
    const step = STEPS[index];

    const from = metersToLatLng(x * STREET_METERS, y * STREET_METERS);
    x += step.x;
    y += step.y;
    const to = metersToLatLng(x * STREET_METERS, y * STREET_METERS);

    covered += Math.hypot(step.x, step.y) * STREET_METERS;
    sampleAlong(from, to, out);
  }

  return [...out, ...out.slice().reverse()];
}

export function buildDenseFalkenbergHistory(
  options: { runs?: number; totalKm?: number; seed?: number } = {},
): LatLng[][] {
  const runs = options.runs ?? DENSE_RUNS;
  const totalKm = options.totalKm ?? DENSE_TOTAL_KM;
  const perRunMeters = (totalKm * 1000) / runs;
  const base = options.seed ?? 13;

  const tracks: LatLng[][] = [];
  for (let i = 0; i < runs; i += 1) tracks.push(buildRun(i * 7919 + base, perRunMeters));
  return tracks;
}

export function denseFalkenbergTracks(
  options: { runs?: number; totalKm?: number; seed?: number } = {},
): [number, number][][] {
  return buildDenseFalkenbergHistory(options).map((track) =>
    track.map((point) => [point.lng, point.lat] as [number, number]),
  );
}

/** Octile path over the street grid through every waypoint, sampled every ~10 m. */
export function routeAlongStreets(waypoints: LatLng[]): LatLng[] {
  const cells = waypoints.map((point) => {
    const { x, y } = latLngToMeters(point);
    return { x: Math.round(x / STREET_METERS), y: Math.round(y / STREET_METERS) };
  });

  if (cells.length === 0) return [];

  let { x, y } = cells[0];
  const out: LatLng[] = [metersToLatLng(x * STREET_METERS, y * STREET_METERS)];

  for (let i = 1; i < cells.length; i += 1) {
    const target = cells[i];
    while (x !== target.x || y !== target.y) {
      const from = metersToLatLng(x * STREET_METERS, y * STREET_METERS);
      x += Math.sign(target.x - x);
      y += Math.sign(target.y - y);
      const to = metersToLatLng(x * STREET_METERS, y * STREET_METERS);
      sampleAlong(from, to, out);
    }
  }

  return out;
}

/** openrouteservice, answered by walking the same streets the history was run on. */
export function streetOrs(options: { roundTripAnswers?: boolean } = {}): OrsStub & {
  readonly routeCalls: number;
  readonly roundTripCalls: number;
} {
  const answerRoundTrip = options.roundTripAnswers !== false;

  const stub = stubOpenRouteServiceWith((call) => {
    if (call.isRoundTrip) {
      if (!answerRoundTrip) return jsonResponse(JSON.stringify({ features: [] }));

      const [lng, lat] = call.body.coordinates[0] as [number, number];
      const length = Number(call.body.options.round_trip.length) || 5_000;
      const seed = Number(call.body.options.round_trip.seed) || 0;
      const geometry = streetRoundTrip({ lat, lng }, length, seed);
      return jsonResponse(orsRouteBody(geometry));
    }

    const coordinates = (call.body.coordinates as [number, number][]).map(([lng, lat]) => ({ lat, lng }));
    const geometry = routeAlongStreets(coordinates);
    if (geometry.length < 2) return jsonResponse(JSON.stringify({ features: [] }));
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
  };
}

/**
 * What `round_trip` gives back: a closed loop over the street grid of roughly
 * the requested length, rotated by the seed. Like the real thing, it takes no
 * view on familiarity — it cannot be steered.
 */
function streetRoundTrip(start: LatLng, lengthMeters: number, seed: number): LatLng[] {
  const origin = latLngToMeters(start);
  const side = Math.max(STREET_METERS, Math.round(lengthMeters / 4 / STREET_METERS) * STREET_METERS);
  const rotation = seed % 4;
  const corners = [
    { x: 0, y: 0 },
    { x: side, y: 0 },
    { x: side, y: side },
    { x: 0, y: side },
  ];
  const ordered = [...corners.slice(rotation), ...corners.slice(0, rotation)];

  return routeAlongStreets([
    start,
    ...ordered.map((corner) => metersToLatLng(origin.x + corner.x, origin.y + corner.y)),
    start,
  ]);
}

function jsonResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

export { FALKENBERG_HOME, polylineDistanceMeters };
