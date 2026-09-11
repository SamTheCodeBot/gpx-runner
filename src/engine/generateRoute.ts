import crypto from "node:crypto";
import { buildLoopWaypointCandidates, type CandidateWaypoints } from "./candidates";
import { familiarityRangeForMode } from "./config";
import { buildFamiliarityIndex, computeFamiliarityRatio } from "./familiarity";
import { buildFamiliarGraph, searchGraphLoops } from "./familiarityGraph";
import { parseGpxToTrackPoints } from "./gpx";
import { assessLoopShape, scoreRoute } from "./scoring/quality";
import { evaluateTrafficSafety } from "./scoring/traffic";
import { canonicalPointKey, computeStraightLineDistance, normalizeLoop, toSegments } from "./utils/geo";
import {
  GenerateRouteInput,
  GenerateRouteResult,
  GeneratedRoute,
  RouteProvider,
  RouteProviderExtras,
  RouteTrafficSummary,
} from "../types";

/** Default wall-clock budget for a whole generation, if the caller sets none. */
export const DEFAULT_GENERATE_BUDGET_MS = 25_000;
/** Slice of the remaining budget the graph search may spend, and its ceiling. */
const GRAPH_BUDGET_FRACTION = 0.2;
const GRAPH_BUDGET_MAX_MS = 2_500;
const GRAPH_BUDGET_MIN_MS = 150;
/** Head-room kept back so the answer can still be scored and assembled. */
const ASSEMBLY_RESERVE_MS = 1_200;
/** Below this there is no point starting another provider batch. */
const MIN_PROVIDER_BATCH_MS = 1_500;
const BATCH_SIZE = 3;

export async function generateRoutes(
  provider: RouteProvider,
  input: GenerateRouteInput,
): Promise<GenerateRouteResult> {
  const deadlineAt = input.deadlineAt ?? Date.now() + DEFAULT_GENERATE_BUDGET_MS;
  const toleranceKm = input.toleranceKm ?? 0.5;
  const familiarityMode = input.familiarityMode ?? "mixed";
  const maxCandidates = input.maxCandidates ?? 20;
  const alternatives = input.alternatives ?? 3;
  const targetMeters = input.targetDistanceKm * 1000;
  const toleranceMeters = toleranceKm * 1000;
  const targetFamiliarityRange = familiarityRangeForMode(familiarityMode);

  const parsedTracks = [
    ...(input.routeCollections ?? []),
    ...(input.gpxFiles ?? []).map((gpx) => parseGpxToTrackPoints(gpx)),
  ]
    .filter((track) => track.length >= 2);
  const familiarityIndex = buildFamiliarityIndex(parsedTracks);
  const familiarGraph = buildFamiliarGraph(parsedTracks, input.start);

  const accepted: GeneratedRoute[] = [];
  /**
   * Good runs that miss only the familiarity band — we still want to show one,
   * with its true percentage. This is the engine's *only* best-effort bucket:
   * length, loop shape and road safety are hard, so a route that fails those is
   * not a near miss, it is not a route.
   */
  const nearMisses: GeneratedRoute[] = [];
  /**
   * Every loop that cleared the non-negotiable gates — drawn by the provider,
   * genuinely loop-shaped, safe — whatever its length or familiarity. Only the
   * caller of last resort touches this, and only ever as "closest real loop",
   * never as a match for what was asked.
   */
  const bestEffort: GeneratedRoute[] = [];
  let rejectedCount = 0;
  let unsafeRejectedCount = 0;
  let timedOut = false;

  const collect = (built: EvaluatedRoute) => {
    if (built.reasons.hardConstraintsOk) bestEffort.push(built.route);

    if (built.decision === "accept") {
      accepted.push(built.route);
      return;
    }
    rejectedCount += 1;
    if (built.reasons.unsafeRoads) unsafeRejectedCount += 1;
    if (built.reasons.familiarityOnly) nearMisses.push(built.route);
  };

  /** Nothing that no routing provider drew ever leaves this function. */
  const routedOnly = (routes: GeneratedRoute[]) => routes.filter((route) => route.routedByProvider);

  const finish = (): GenerateRouteResult => ({
    routes: routedOnly(dedupeRoutes(accepted).sort(byDistanceThenScore(targetMeters))).slice(0, alternatives),
    nearMisses: routedOnly(
      dedupeRoutes(nearMisses).sort(byFamiliarityDistance(targetFamiliarityRange, targetMeters)),
    ).slice(0, alternatives),
    bestEffort: routedOnly(dedupeRoutes(bestEffort).sort(byDistanceThenScore(targetMeters))).slice(
      0,
      alternatives,
    ),
    rejectedCount,
    unsafeRejectedCount,
    timedOut,
  });

  /**
   * Routes a batch of waypoint proposals through the provider.
   *
   * Every route the engine can return is born here: the provider's geometry is
   * the only geometry that follows real ways, so it is the only geometry that
   * ever reaches a runner. Each call is given what is left of the deadline,
   * and the fan-out stops when there is no longer time for another batch.
   */
  const routeCandidates = async (
    candidates: CandidateWaypoints[],
    source: GeneratedRoute["source"],
  ): Promise<void> => {
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= MIN_PROVIDER_BATCH_MS) {
        timedOut = true;
        return;
      }

      const batch = candidates.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (candidate) => {
          const providerResult = await provider.route({
            coordinates: [input.start, ...candidate.waypoints, input.start],
            routeStyle: input.routeStyle,
            preferQuiet: input.preferQuiet,
            preferGreen: input.preferGreen,
            timeoutMs: Math.max(1_000, remaining - ASSEMBLY_RESERVE_MS),
          });
          if (!providerResult || providerResult.geometry.length < 2) return null;

          return evaluateBuiltRoute({
            geometry: providerResult.geometry,
            requestedWaypoints: candidate.waypoints,
            distanceMeters: providerResult.distanceMeters,
            elevationGainMeters: providerResult.elevationGainMeters,
            extras: providerResult.extras,
            source,
            seed: candidate.seed,
            input,
            familiarityIndex,
            targetMeters,
            targetFamiliarityRange,
          });
        }),
      );

      for (const built of results) {
        if (!built) rejectedCount += 1;
        else collect(built);
      }

      if (accepted.length >= alternatives) return;
    }
  };

  // ── 1. The runner's own ground ─────────────────────────────────────────────
  // The graph search only proposes where to go. It works on 11 m-quantised GPS
  // history and closes its loops with a straight stitch, so its own geometry is
  // not routable — we take waypoints off it and let the provider draw the line.
  const graphBudgetMs = Math.min(
    GRAPH_BUDGET_MAX_MS,
    Math.max(0, (deadlineAt - Date.now() - ASSEMBLY_RESERVE_MS) * GRAPH_BUDGET_FRACTION),
  );

  const graphSearch =
    familiarityMode !== "new" && parsedTracks.length > 0 && graphBudgetMs >= GRAPH_BUDGET_MIN_MS
      ? searchGraphLoops(familiarGraph, targetMeters, toleranceMeters, {
          maxResults: Math.max(3, alternatives * 2),
          budgetMs: graphBudgetMs,
          waypointCount: waypointCountFor(targetMeters),
        })
      : null;

  const graphCandidates: CandidateWaypoints[] = (graphSearch?.loops ?? [])
    .filter((loop) => loop.waypoints.length >= 2)
    .map((loop, index) => ({ seed: `graph-loop-${index}`, waypoints: loop.waypoints }));

  await routeCandidates(graphCandidates, "familiar-graph");
  if (accepted.length >= alternatives) return finish();

  // ── 2. Geometric loop candidates around the start ──────────────────────────
  await routeCandidates(
    buildLoopWaypointCandidates(
      input.start,
      targetMeters,
      Math.min(maxCandidates, familiarityMode === "familiar" ? 12 : 20),
      familiarityMode,
      parsedTracks,
    ),
    "provider",
  );

  return finish();
}

/** Enough waypoints to hold the provider to the proposed loop, not so many that it cannot route. */
function waypointCountFor(targetMeters: number): number {
  return Math.max(4, Math.min(10, Math.round(targetMeters / 800)));
}

function byDistanceThenScore(targetMeters: number) {
  return (a: GeneratedRoute, b: GeneratedRoute) => {
    const distDiffA = Math.abs(a.distanceMeters - targetMeters);
    const distDiffB = Math.abs(b.distanceMeters - targetMeters);
    if (distDiffA !== distDiffB) return distDiffA - distDiffB;
    return b.score - a.score;
  };
}

/** How far outside the requested familiarity band a route sits. */
export function familiarityBandDistance(ratio: number, range: { min: number; max: number }): number {
  if (ratio < range.min) return range.min - ratio;
  if (ratio > range.max) return ratio - range.max;
  return 0;
}

function byFamiliarityDistance(range: { min: number; max: number }, targetMeters: number) {
  return (a: GeneratedRoute, b: GeneratedRoute) => {
    const bandA = familiarityBandDistance(a.familiarityRatio, range);
    const bandB = familiarityBandDistance(b.familiarityRatio, range);
    if (Math.abs(bandA - bandB) > 0.02) return bandA - bandB;
    return byDistanceThenScore(targetMeters)(a, b);
  };
}

export type EvaluatedRoute = {
  route: GeneratedRoute;
  decision: "accept" | "reject";
  reasons: {
    distanceOk: boolean;
    loopOk: boolean;
    familiarityOk: boolean;
    safetyOk: boolean;
    unsafeRoads: boolean;
    /** True when familiarity is the only thing standing between this route and acceptance. */
    familiarityOnly: boolean;
    /**
     * True when every constraint that is never negotiable holds: the geometry
     * came from the router, it is a loop of the right shape, and it is safe.
     * Such a route is runnable even if it is the wrong length or the wrong
     * familiarity, which is what makes it usable as a last resort.
     */
    hardConstraintsOk: boolean;
  };
};

/**
 * Judges one routed candidate.
 *
 * Hard constraints — never relaxed, on any path, to avoid an empty answer:
 *   distance within tolerance, loop shape (`assessLoopShape`), road safety,
 *   and the geometry having come from the routing provider at all.
 *
 * Soft constraint — the only one:
 *   the familiarity band. A route that clears every hard gate and misses only
 *   this is a *near miss*, returned with its measured percentage attached so
 *   the runner is told the truth rather than shown nothing.
 */
export function evaluateBuiltRoute(params: {
  geometry: GenerateRouteInput["start"][];
  /** The waypoints the provider was asked to visit, when this came from a request. */
  requestedWaypoints?: GenerateRouteInput["start"][];
  distanceMeters: number;
  elevationGainMeters?: number;
  extras?: RouteProviderExtras;
  source: GeneratedRoute["source"];
  seed: string;
  input: GenerateRouteInput;
  familiarityIndex: ReturnType<typeof buildFamiliarityIndex>;
  targetMeters: number;
  targetFamiliarityRange: { min: number; max: number };
}): EvaluatedRoute {
  const toleranceMeters = (params.input.toleranceKm ?? 0.5) * 1000;
  const loopGeometry = normalizeLoop(params.geometry);
  const segments = toSegments(loopGeometry);
  const familiarityMode = params.input.familiarityMode ?? "mixed";
  const hasFamiliarData = params.familiarityIndex.familiarSegments.length > 0;

  let familiarityRatio = hasFamiliarData
    ? computeFamiliarityRatio(segments, params.familiarityIndex)
    : familiarityMode === "new"
      ? 0
      : familiarityMode === "familiar"
        ? 1
        : 0.5;

  familiarityRatio = Math.max(0, Math.min(1, familiarityRatio));

  const shape = assessLoopShape(loopGeometry, params.input.start, params.targetMeters);
  const { ok: loopOk, outAndBackRatio, closureErrorMeters, ...loopMetrics } = shape;

  const traffic: RouteTrafficSummary = evaluateTrafficSafety({
    distanceMeters: params.distanceMeters,
    extras: params.extras,
  });
  const avoidUnsafeRoads = params.input.avoidUnsafeRoads ?? true;
  const safetyOk = !avoidUnsafeRoads || !traffic.unsafeRoads;

  const distanceDelta = Math.abs(params.distanceMeters - params.targetMeters);
  const distanceOk = distanceDelta <= toleranceMeters;
  const familiarityOk =
    !hasFamiliarData ||
    (familiarityRatio >= params.targetFamiliarityRange.min && familiarityRatio <= params.targetFamiliarityRange.max);

  const { score: shapeScore, debug } = scoreRoute({
    distanceMeters: params.distanceMeters,
    targetMeters: params.targetMeters,
    familiarityRatio,
    targetFamiliarityRange: params.targetFamiliarityRange,
    outAndBackRatio,
    closureErrorMeters,
    ...loopMetrics,
  });

  // Prefer quiet ways, penalise busy and noisy ones — the same signals the
  // round-trip flow uses, applied here so familiarity-aware suggestions also
  // avoid big roads.
  const trafficAdjustment = traffic.hasTrafficData
    ? traffic.trafficPenalty * 0.35 - traffic.quietWayRatio * 15
    : 0;
  const score = shapeScore - trafficAdjustment;

  const route: GeneratedRoute = {
    id: crypto.randomUUID(),
    source: params.source,
    distanceMeters: params.distanceMeters,
    elevationGainMeters: params.elevationGainMeters,
    geometry: loopGeometry,
    segments,
    familiarityRatio,
    familiarityMeasured: hasFamiliarData,
    // Only ever built from a provider response; graph geometry never gets here.
    routedByProvider: true,
    traffic,
    score,
    debug: {
      seed: params.seed,
      targetMeters: params.targetMeters,
      stateRoadMeters: traffic.stateRoadMeters,
      roadMeters: traffic.roadMeters,
      noisyMeters: traffic.noisyMeters,
      quietWayRatio: traffic.quietWayRatio,
      trafficPenalty: traffic.trafficPenalty,
      unsafeRoads: traffic.unsafeRoads,
      closureErrorMeters,
      outAndBackRatio,
      angularCoverage: loopMetrics.angularCoverage,
      radialStdRatio: loopMetrics.radialStdRatio,
      minRadiusRatio: loopMetrics.minRadiusRatio,
      maxRadiusRatio: loopMetrics.maxRadiusRatio,
      centerCrossPenalty: loopMetrics.centerCrossPenalty,
      ...debug,
    },
  };

  // ── Provider sanity check ──────────────────────────────────────────────────
  // Every waypoint we asked for has to be visited, so the route can never be
  // shorter than the straight lines between them. Coming back at barely that
  // length means the provider dropped the waypoints and answered with a
  // shortcut — a different route from the one that was proposed.
  const waypointPathDistance = computeStraightLineDistance([
    params.input.start,
    ...(params.requestedWaypoints ?? params.geometry.slice(0, -1)),
    params.input.start,
  ]);
  const providerShortcut =
    params.distanceMeters < waypointPathDistance * 1.15 && params.distanceMeters < params.targetMeters * 0.4;

  const reasons = {
    distanceOk: distanceOk && !providerShortcut,
    loopOk,
    familiarityOk,
    safetyOk,
    unsafeRoads: traffic.unsafeRoads,
    familiarityOnly: !familiarityOk && distanceOk && !providerShortcut && loopOk && safetyOk,
    hardConstraintsOk: loopOk && safetyOk && !providerShortcut,
  };

  if (providerShortcut) {
    return {
      route: { ...route, debug: { ...route.debug, waypointPathShort: true } },
      decision: "reject",
      reasons,
    };
  }

  if (distanceOk && familiarityOk && loopOk && safetyOk) return { route, decision: "accept", reasons };
  return { route, decision: "reject", reasons };
}

function dedupeRoutes(routes: GeneratedRoute[]): GeneratedRoute[] {
  const kept: GeneratedRoute[] = [];

  for (const route of routes.sort((a, b) => b.score - a.score)) {
    const alreadySimilar = kept.some((existing) => {
      const distDiff = Math.abs(existing.distanceMeters - route.distanceMeters);
      const famDiff = Math.abs(existing.familiarityRatio - route.familiarityRatio);
      return distDiff < 220 && famDiff < 0.08 && geometrySimilarity(existing.geometry, route.geometry) >= 0.74;
    });

    if (!alreadySimilar) kept.push(route);
  }

  return kept;
}

function geometrySimilarity(a: GenerateRouteInput["start"][], b: GenerateRouteInput["start"][]): number {
  const sigA = new Set(a.map((p) => canonicalPointKey(p, 4)));
  const sigB = new Set(b.map((p) => canonicalPointKey(p, 4)));
  let shared = 0;
  for (const key of sigA) if (sigB.has(key)) shared += 1;
  return shared / Math.max(1, Math.min(sigA.size, sigB.size));
}
