import { RouteExtraSummary, RouteProviderExtras } from "../../types";

/**
 * Road avoidance, shared by both generation paths.
 *
 * Historically this logic lived inside the round-trip flow in
 * `src/api/routeGeneratorService.ts`, so the waypoint (familiarity-aware) path
 * produced suggestions that happily ran along state roads. It lives here now so
 * both paths reject the same roads and prefer the same quiet ways.
 *
 * Values come from the openrouteservice `waytype` and `noise` extras:
 * https://giscience.github.io/openrouteservice/api-reference/endpoints/directions/extra-info/waytype
 */
export const WAYTYPE = {
  unknown: 0,
  stateRoad: 1, // primary/motorway/trunk — never send a runner here
  road: 2, // secondary/tertiary/unclassified
  street: 3, // residential/service/living_street
  path: 4,
  track: 5,
  cycleway: 6,
  footway: 7,
  steps: 8,
  ferry: 9,
  construction: 10,
} as const;

/** Ways the story asks us to prefer: bicycle paths and other quiet ways. */
const QUIET_WAYTYPES: number[] = [WAYTYPE.path, WAYTYPE.track, WAYTYPE.cycleway, WAYTYPE.footway];

export type TrafficSafety = {
  /** False when the provider returned no waytype/noise extras — nothing can be judged. */
  hasTrafficData: boolean;
  stateRoadMeters: number;
  roadMeters: number;
  noisyMeters: number;
  quietWayMeters: number;
  /** Share of the route on paths, tracks, cycleways and footways (0..1). */
  quietWayRatio: number;
  trafficPenalty: number;
  unsafeRoads: boolean;
};

export function summaryDistance(
  summary: RouteExtraSummary[] | undefined,
  predicate: (value: number) => boolean,
): number {
  if (!Array.isArray(summary)) return 0;
  return summary
    .filter((item) => predicate(item.value))
    .reduce((sum, item) => sum + Math.max(0, item.distance), 0);
}

export function evaluateTrafficSafety(route: {
  distanceMeters: number;
  extras?: RouteProviderExtras;
}): TrafficSafety {
  const hasTrafficData =
    Array.isArray(route.extras?.waytype) || Array.isArray(route.extras?.noise);

  const stateRoadMeters = summaryDistance(route.extras?.waytype, (value) => value === WAYTYPE.stateRoad);
  const roadMeters = summaryDistance(route.extras?.waytype, (value) => value === WAYTYPE.road);
  const quietWayMeters = summaryDistance(route.extras?.waytype, (value) => QUIET_WAYTYPES.includes(value));
  const noisyMeters = summaryDistance(route.extras?.noise, (value) => value >= 6);
  const veryNoisyMeters = summaryDistance(route.extras?.noise, (value) => value >= 8);
  const distance = Math.max(1, route.distanceMeters);

  const unsafeRoads =
    hasTrafficData &&
    (stateRoadMeters > 450 || veryNoisyMeters > 600 || noisyMeters / distance > 0.28);

  return {
    hasTrafficData,
    stateRoadMeters: Math.round(stateRoadMeters),
    roadMeters: Math.round(roadMeters),
    noisyMeters: Math.round(noisyMeters),
    quietWayMeters: Math.round(quietWayMeters),
    quietWayRatio: Math.max(0, Math.min(1, quietWayMeters / distance)),
    trafficPenalty:
      (stateRoadMeters / distance) * 520 +
      (roadMeters / distance) * 95 +
      (noisyMeters / distance) * 240 +
      (veryNoisyMeters / distance) * 360,
    unsafeRoads,
  };
}
