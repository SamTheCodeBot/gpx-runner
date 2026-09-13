import { haversineMeters, polylineDistanceMeters } from "../utils/geo";
import type { Street } from "./inventory";
import type { LatLng, RouteProvider, RouteStyle } from "../../types";

/**
 * A route that covers the streets he ticked.
 *
 * Deliberately not a suggestion. The route engine next door asks what a good
 * run *would* be — right length, right shape, the right amount of ground he
 * already knows. This asks nothing: he has named the streets, and the only job
 * left is to visit them in an order that is not idiotic and come home.
 *
 * So there is no familiarity in this file, no target distance and no scoring.
 * The distance is whatever the streets add up to. That is the feature.
 *
 * What it does share with everything else here is the hard rule: the line that
 * comes back is drawn by the routing provider, never by us. Joining the streets
 * with straight geometry would put the run through gardens and across the
 * Ätran, which is the bug we spent a day killing.
 */

/** openrouteservice takes 50 coordinates in one directions call. */
export const MAX_COORDINATES_PER_CALL = 50;

/**
 * Each street is asked for as both ends and its middle.
 *
 * Two points would let the router take any path between them, which on a street
 * shaped like a C is the straight road round the outside — covering none of it.
 * The midpoint pins the route to the street itself.
 */
export const WAYPOINTS_PER_STREET = 3;

/**
 * How many streets one route may cover.
 *
 * Not a guess: 40 streets is 122 waypoints, which is three directions calls out
 * of a purse of eight, and comfortably inside one request's deadline. It is
 * also already a very long run. The UI stops him at this number and says so —
 * quietly routing 40 of the 60 he ticked would be a route that silently is not
 * the thing he asked for.
 */
export const MAX_SELECTED_STREETS = 40;

export type StreetRouteErrorCode =
  | "no-streets"
  | "too-many-streets"
  | "no-geometry"
  | "provider-refused"
  | "budget-exhausted"
  | "out-of-time";

export class StreetRouteError extends Error {
  constructor(
    message: string,
    readonly code: StreetRouteErrorCode,
  ) {
    super(message);
    this.name = "StreetRouteError";
  }
}

export type StreetRoutePlan = {
  /** Provider-drawn, every metre of it. */
  geometry: LatLng[];
  distanceMeters: number;
  elevationGainMeters?: number;
  /** Street ids in the order the route visits them. */
  streetOrder: string[];
  streetNames: string[];
  /** Metres of street the selection asked for, before any joining up. */
  streetMeters: number;
  waypointCount: number;
  legCount: number;
};

type AnchoredStreet = {
  street: Street;
  /** Both ends of the longest in-scope stretch of this street. */
  ends: [LatLng, LatLng];
  mid: LatLng;
};

/** The point half way along a polyline, measured, not the middle of the array. */
function midpointAlong(points: LatLng[]): LatLng {
  const total = polylineDistanceMeters(points);
  if (total <= 0) return points[0];

  let travelled = 0;
  for (let i = 1; i < points.length; i += 1) {
    const step = haversineMeters(points[i - 1], points[i]);
    if (travelled + step >= total / 2) {
      const fraction = step > 0 ? (total / 2 - travelled) / step : 0;
      return {
        lat: points[i - 1].lat + (points[i].lat - points[i - 1].lat) * fraction,
        lng: points[i - 1].lng + (points[i].lng - points[i - 1].lng) * fraction,
      };
    }
    travelled += step;
  }
  return points[points.length - 1];
}

/**
 * A street reduced to the three points worth asking the router for.
 *
 * Where a street leaves the project area and comes back, the inventory stores
 * it as several stretches. We route the longest one: covering the rest would
 * mean treating one street as several stops, and the ones that survive that
 * split are usually a few metres of junction.
 */
export function anchorStreet(street: Street): AnchoredStreet | null {
  const pieces = street.geometry.filter((piece) => piece.length >= 2);
  if (pieces.length === 0) return null;

  const longest = pieces.reduce((best, piece) =>
    polylineDistanceMeters(piece) > polylineDistanceMeters(best) ? piece : best,
  );

  return {
    street,
    ends: [longest[0], longest[longest.length - 1]],
    mid: midpointAlong(longest),
  };
}

type WalkedStreet = { anchored: AnchoredStreet; entry: LatLng; exit: LatLng; reversed: boolean };

/**
 * Walks an order, entering each street by whichever end is nearer.
 *
 * The cost that comes back is the joining-up only. The streets themselves are
 * the same length whatever order they are run in, so including them would just
 * add a constant to every candidate and flatten the comparison.
 */
function walkOrder(
  start: LatLng,
  order: AnchoredStreet[],
): { connectorMeters: number; legs: WalkedStreet[] } {
  let cursor = start;
  let connectorMeters = 0;
  const legs: WalkedStreet[] = [];

  for (const anchored of order) {
    const [a, b] = anchored.ends;
    const toA = haversineMeters(cursor, a);
    const toB = haversineMeters(cursor, b);
    const reversed = toB < toA;

    connectorMeters += reversed ? toB : toA;
    const entry = reversed ? b : a;
    const exit = reversed ? a : b;
    legs.push({ anchored, entry, exit, reversed });
    cursor = exit;
  }

  // And home again — the half of the problem a plain nearest-neighbour forgets.
  connectorMeters += haversineMeters(cursor, start);
  return { connectorMeters, legs };
}

function nearestNeighbourOrder(start: LatLng, streets: AnchoredStreet[]): AnchoredStreet[] {
  const remaining = [...streets];
  const order: AnchoredStreet[] = [];
  let cursor = start;

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestCost = Number.POSITIVE_INFINITY;

    for (let i = 0; i < remaining.length; i += 1) {
      const [a, b] = remaining[i].ends;
      const cost = Math.min(haversineMeters(cursor, a), haversineMeters(cursor, b));
      if (cost < bestCost) {
        bestCost = cost;
        bestIndex = i;
      }
    }

    const [picked] = remaining.splice(bestIndex, 1);
    order.push(picked);
    const [a, b] = picked.ends;
    cursor = haversineMeters(cursor, a) <= haversineMeters(cursor, b) ? b : a;
  }

  return order;
}

/** Enough passes to undo the crossings nearest-neighbour leaves, not enough to cost anything. */
const TWO_OPT_PASSES = 4;
/** Below this an "improvement" is floating-point noise, and the loop never ends. */
const TWO_OPT_MIN_GAIN_METERS = 1;

/**
 * Un-crosses the order nearest-neighbour produced.
 *
 * Greedy ordering always ends the same way: it happily strands one street on
 * the far side of town and pays for it on the way home. Reversing a run of
 * stops is the classic fix and, at forty streets, costs microseconds.
 */
function twoOptOrder(start: LatLng, order: AnchoredStreet[]): AnchoredStreet[] {
  let best = order;
  let bestCost = walkOrder(start, best).connectorMeters;

  for (let pass = 0; pass < TWO_OPT_PASSES; pass += 1) {
    let improved = false;

    for (let i = 0; i < best.length - 1; i += 1) {
      for (let j = i + 1; j < best.length; j += 1) {
        const candidate = [
          ...best.slice(0, i),
          ...best.slice(i, j + 1).reverse(),
          ...best.slice(j + 1),
        ];
        const cost = walkOrder(start, candidate).connectorMeters;
        if (cost < bestCost - TWO_OPT_MIN_GAIN_METERS) {
          best = candidate;
          bestCost = cost;
          improved = true;
        }
      }
    }

    if (!improved) break;
  }

  return best;
}

/** The visiting order: nearest neighbour from the start, then the crossings taken out. */
export function orderStreetsForRoute(start: LatLng, streets: Street[]): { order: Street[]; legs: WalkedStreet[] } {
  const anchored = streets.map(anchorStreet).filter((entry): entry is AnchoredStreet => entry !== null);
  if (anchored.length === 0) return { order: [], legs: [] };

  const ordered = twoOptOrder(start, nearestNeighbourOrder(start, anchored));
  const { legs } = walkOrder(start, ordered);
  return { order: ordered.map((entry) => entry.street), legs };
}

/** start → (in, middle, out) for each street → start. */
export function buildStreetWaypoints(start: LatLng, legs: WalkedStreet[]): LatLng[] {
  const waypoints: LatLng[] = [start];
  for (const leg of legs) waypoints.push(leg.entry, leg.anchored.mid, leg.exit);
  waypoints.push(start);
  return waypoints;
}

/**
 * Waypoints cut into calls the provider will accept.
 *
 * Consecutive legs share the waypoint they meet at, so the router is asked to
 * arrive at and then depart from the same point rather than teleporting across
 * the seam.
 */
export function splitIntoLegs(waypoints: LatLng[], maxPerCall = MAX_COORDINATES_PER_CALL): LatLng[][] {
  if (waypoints.length <= maxPerCall) return [waypoints];

  const legs: LatLng[][] = [];
  let index = 0;
  while (index < waypoints.length - 1) {
    const end = Math.min(index + maxPerCall, waypoints.length);
    legs.push(waypoints.slice(index, end));
    index = end - 1;
  }
  return legs;
}

/** How many calls a selection of this size will cost, for the UI to promise before it spends. */
export function legCountForStreets(streetCount: number): number {
  return splitIntoLegs(new Array(streetCount * WAYPOINTS_PER_STREET + 2).fill({ lat: 0, lng: 0 })).length;
}

export type PlanStreetRouteInput = {
  start: LatLng;
  streets: Street[];
  routeStyle?: RouteStyle;
  /** Epoch-ms this must be finished by. Each call gets what is left of it. */
  deadlineAt?: number;
};

/**
 * The route, drawn by the provider, leg by leg.
 *
 * There is no fallback to straight lines and there must never be one: a
 * half-routed answer looks like a route, exports like a route, and sends him
 * across a field. If the provider will not draw it, this throws and the runner
 * is told why.
 */
export async function planStreetRoute(
  provider: RouteProvider,
  input: PlanStreetRouteInput,
): Promise<StreetRoutePlan> {
  if (input.streets.length === 0) {
    throw new StreetRouteError("Tick at least one street first.", "no-streets");
  }

  if (input.streets.length > MAX_SELECTED_STREETS) {
    throw new StreetRouteError(
      `One route can cover ${MAX_SELECTED_STREETS} streets at a time — you picked ${input.streets.length}.`,
      "too-many-streets",
    );
  }

  const { order, legs } = orderStreetsForRoute(input.start, input.streets);
  if (legs.length === 0) {
    throw new StreetRouteError("Those streets have no usable geometry in this project.", "no-geometry");
  }

  const waypoints = buildStreetWaypoints(input.start, legs);
  const callLegs = splitIntoLegs(waypoints);

  const geometry: LatLng[] = [];
  let distanceMeters = 0;
  let elevationGainMeters = 0;

  for (const callWaypoints of callLegs) {
    if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) {
      throw new StreetRouteError(
        "Ran out of time drawing that route — try fewer streets.",
        "out-of-time",
      );
    }

    const result = await provider.route({
      coordinates: callWaypoints,
      routeStyle: input.routeStyle ?? "mixed",
      timeoutMs: input.deadlineAt !== undefined ? input.deadlineAt - Date.now() : undefined,
    });

    if (!result || result.geometry.length < 2) {
      const failures = provider.takeFailures?.() ?? [];
      const refused = failures.some((failure) => failure.kind === "rate-limited");
      throw new StreetRouteError(
        refused
          ? "openrouteservice is rate-limited right now — try again in a minute."
          : "The router could not join those streets up. Try ticking fewer, or streets closer together.",
        failures.length > 0 ? "provider-refused" : "budget-exhausted",
      );
    }

    // The seam waypoint belongs to both legs; keep one copy of it.
    const points = geometry.length > 0 ? result.geometry.slice(1) : result.geometry;
    geometry.push(...points);
    distanceMeters += result.distanceMeters;
    elevationGainMeters += result.elevationGainMeters ?? 0;
  }

  return {
    geometry,
    distanceMeters,
    elevationGainMeters,
    streetOrder: order.map((street) => street.id),
    streetNames: order.map((street) => street.name),
    streetMeters: input.streets.reduce((sum, street) => sum + street.lengthMeters, 0),
    waypointCount: waypoints.length,
    legCount: callLegs.length,
  };
}
