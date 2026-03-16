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
import { canonicalPointKey, normalizeLoop, toSegments } from "./utils/geo";
import { GenerateRouteInput, GeneratedRoute, RouteProvider } from "../types";

export async function generateRoutes(
  provider: RouteProvider,
  input: GenerateRouteInput,
): Promise<{ routes: GeneratedRoute[]; rejectedCount: number }> {
  const toleranceKm = input.toleranceKm ?? 1;
  const familiarityMode = input.familiarityMode ?? "mixed";
  const maxCandidates = input.maxCandidates ?? 180;
  const alternatives = input.alternatives ?? 3;
  const targetMeters = input.targetDistanceKm * 1000;
  const toleranceMeters = toleranceKm * 1000;
  const targetFamiliarityRange = familiarityRangeForMode(familiarityMode);

  const parsedTracks = (input.gpxFiles ?? [])
    .map((gpx) => parseGpxToTrackPoints(gpx))
    .filter((track) => track.length >= 2);
  const familiarityIndex = buildFamiliarityIndex(parsedTracks);
  const familiarGraph = buildFamiliarGraph(parsedTracks, input.start);

  const accepted: GeneratedRoute[] = [];
  let rejectedCount = 0;

  const graphLoops =
    familiarityMode !== "new" && parsedTracks.length > 0
      ? findGraphLoops(familiarGraph, targetMeters, toleranceMeters, Math.max(10, alternatives * 8))
      : [];

  for (const geometry of graphLoops) {
    const built = evaluateBuiltRoute({
      geometry,
      distanceMeters: routeDistanceOnGraph(geometry),
      source: "familiar-graph",
      seed: "graph-loop",
      input,
      familiarityIndex,
      targetMeters,
      targetFamiliarityRange,
    });

    if (built.decision === "accept") accepted.push(built.route);
    else rejectedCount += 1;
  }

  const candidateWaypoints = buildLoopWaypointCandidates(
    input.start,
    targetMeters,
    maxCandidates,
    familiarityMode,
    parsedTracks,
  );

  for (const candidate of candidateWaypoints) {
    const requestPoints = [input.start, ...candidate.waypoints, input.start];
    const providerResult = await provider.route({ coordinates: requestPoints });

    if (!providerResult || providerResult.geometry.length < 2) {
      rejectedCount += 1;
      continue;
    }

    const built = evaluateBuiltRoute({
      geometry: providerResult.geometry,
      distanceMeters: providerResult.distanceMeters,
      source: "provider",
      seed: candidate.seed,
      input,
      familiarityIndex,
      targetMeters,
      targetFamiliarityRange,
    });

    if (built.decision === "accept") accepted.push(built.route);
    else rejectedCount += 1;
  }

  const bestAccepted = dedupeRoutes(accepted).sort((a, b) => b.score - a.score);
  return { routes: bestAccepted.slice(0, alternatives), rejectedCount };
}

function evaluateBuiltRoute(params: {
  geometry: GenerateRouteInput["start"][];
  distanceMeters: number;
  source: GeneratedRoute["source"];
  seed: string;
  input: GenerateRouteInput;
  familiarityIndex: ReturnType<typeof buildFamiliarityIndex>;
  targetMeters: number;
  targetFamiliarityRange: { min: number; max: number };
}): { route: GeneratedRoute; decision: "accept" | "reject" } {
  const toleranceMeters = (params.input.toleranceKm ?? 1) * 1000;
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

  const { score, debug } = scoreRoute({
    distanceMeters: params.distanceMeters,
    targetMeters: params.targetMeters,
    familiarityRatio,
    targetFamiliarityRange: params.targetFamiliarityRange,
    outAndBackRatio,
    closureErrorMeters,
    ...loopMetrics,
  });

  const route: GeneratedRoute = {
    id: crypto.randomUUID(),
    source: params.source,
    distanceMeters: params.distanceMeters,
    geometry: loopGeometry,
    segments,
    familiarityRatio,
    score,
    debug: {
      seed: params.seed,
      targetMeters: params.targetMeters,
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

  if (distanceOk && familiarityOk && loopOk) return { route, decision: "accept" };
  return { route, decision: "reject" };
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
