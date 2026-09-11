import crypto from "node:crypto";
import { buildLoopWaypointCandidates } from "./candidates";
import { familiarityRangeForMode } from "./config";
import { buildFamiliarityIndex, computeFamiliarityRatio } from "./familiarity";
import { buildFamiliarGraph, findGraphLoops, routeDistanceOnGraph } from "./familiarityGraph";
import { parseGpxToTrackPoints } from "./gpx";
import {
  computeClosureErrorMeters,
  computeLoopShapeMetrics,
  computeOutAndBackRatio,
  scoreRoute,
} from "./scoring/quality";
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

export async function generateRoutes(
  provider: RouteProvider,
  input: GenerateRouteInput,
): Promise<GenerateRouteResult> {
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
  /** Good runs that miss only the familiarity band — we still want to show one. */
  const nearMisses: GeneratedRoute[] = [];
  let rejectedCount = 0;
  let unsafeRejectedCount = 0;

  const collect = (built: EvaluatedRoute) => {
    if (built.decision === "accept") {
      accepted.push(built.route);
      return;
    }
    rejectedCount += 1;
    if (built.reasons.unsafeRoads) unsafeRejectedCount += 1;
    if (built.reasons.familiarityOnly) nearMisses.push(built.route);
  };

  const finish = (): GenerateRouteResult => ({
    routes: dedupeRoutes(accepted).sort(byDistanceThenScore(targetMeters)).slice(0, alternatives),
    nearMisses: dedupeRoutes(nearMisses)
      .sort(byFamiliarityDistance(targetFamiliarityRange, targetMeters))
      .slice(0, alternatives),
    rejectedCount,
    unsafeRejectedCount,
  });

  const graphLoops =
    familiarityMode !== "new" && parsedTracks.length > 0
      ? findGraphLoops(familiarGraph, targetMeters, toleranceMeters, Math.max(10, alternatives * 8))
      : [];

  for (const geometry of graphLoops) {
    collect(
      evaluateBuiltRoute({
        geometry,
        distanceMeters: routeDistanceOnGraph(geometry),
        source: "familiar-graph",
        seed: "graph-loop",
        input,
        familiarityIndex,
        targetMeters,
        targetFamiliarityRange,
      }),
    );
  }

  if (accepted.length >= alternatives) return finish();

  const candidateWaypoints = buildLoopWaypointCandidates(
    input.start,
    targetMeters,
    Math.min(maxCandidates, familiarityMode === "familiar" ? 12 : 20),
    familiarityMode,
    parsedTracks,
  );

  const BATCH_SIZE = 3;
  for (let i = 0; i < candidateWaypoints.length; i += BATCH_SIZE) {
    const batch = candidateWaypoints.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (candidate) => {
        const requestPoints = [input.start, ...candidate.waypoints, input.start];
        const providerResult = await provider.route({
          coordinates: requestPoints,
          routeStyle: input.routeStyle,
          preferQuiet: input.preferQuiet,
          preferGreen: input.preferGreen,
        });
        if (!providerResult || providerResult.geometry.length < 2) {
          return { candidate, built: null };
        }
        const built = evaluateBuiltRoute({
          geometry: providerResult.geometry,
          distanceMeters: providerResult.distanceMeters,
          elevationGainMeters: providerResult.elevationGainMeters,
          extras: providerResult.extras,
          source: "provider",
          seed: candidate.seed,
          input,
          familiarityIndex,
          targetMeters,
          targetFamiliarityRange,
        });
        return { candidate, built };
      }),
    );

    for (const { built } of results) {
      if (!built) rejectedCount += 1;
      else collect(built);
    }

    if (accepted.length >= alternatives) break;
  }

  return finish();
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
  };
};

export function evaluateBuiltRoute(params: {
  geometry: GenerateRouteInput["start"][];
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

  const outAndBackRatio = computeOutAndBackRatio(segments);
  const closureErrorMeters = computeClosureErrorMeters(loopGeometry);
  const loopMetrics = computeLoopShapeMetrics(loopGeometry, params.input.start, params.targetMeters);

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

  const loopOk =
    outAndBackRatio <= 0.2 &&
    closureErrorMeters <= 50 &&
    loopMetrics.angularCoverage >= 0.72 &&
    loopMetrics.minRadiusRatio >= 0.46 &&
    loopMetrics.centerCrossPenalty <= 0.12;

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
  // If the provider returned a route that is less than 40% of the target distance
  // AND less than 1.15× the straight-line waypoint path, it may have ignored the
  // intermediate waypoints and returned a near-straight-line shortcut.
  const waypointPathDistance = computeStraightLineDistance([params.input.start, ...params.geometry.slice(0, -1)]);
  const providerShortcut =
    params.distanceMeters < waypointPathDistance * 1.15 && params.distanceMeters < params.targetMeters * 0.4;

  const reasons = {
    distanceOk: distanceOk && !providerShortcut,
    loopOk,
    familiarityOk,
    safetyOk,
    unsafeRoads: traffic.unsafeRoads,
    familiarityOnly: !familiarityOk && distanceOk && !providerShortcut && loopOk && safetyOk,
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
