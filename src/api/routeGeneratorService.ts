import { generateRoutes } from "../engine/generateRoute";
import { OpenRouteServiceProvider } from "../engine/providers/openRouteService";
import { assessLoopShape } from "../engine/scoring/quality";
import { evaluateTrafficSafety } from "../engine/scoring/traffic";
import { GenerateRouteInput, LatLng, RouteProviderResult } from "../types";
import { haversineMeters } from "../engine/utils/geo";

/** Head-room kept back so the answer can still be assembled before the deadline. */
const ASSEMBLY_RESERVE_MS = 1_200;
/** Below this there is no point starting another round-trip batch. */
const MIN_BATCH_MS = 1_500;

export async function generateTrainingRoutes(input: GenerateRouteInput) {
  const provider = new OpenRouteServiceProvider(process.env.OPENROUTESERVICE_API_KEY ?? "");
  return generateRoutes(provider, input);
}

export type RoundTripSuggestionInput = {
  start: LatLng;
  targetDistanceKm: number;
  /** Epoch-ms the fan-out must finish by. Whatever was found by then is returned. */
  deadlineAt?: number;
  toleranceKm?: number;
  alternatives?: number;
  routeStyle?: "road" | "mixed" | "trail";
  preferQuiet?: boolean;
  preferGreen?: boolean;
  elevationPreference?: "any" | "hilly" | "flat";
  directionShift?: number;
};

export type RoundTripSuggestionResult = {
  distanceMeters: number;
  elevationGainMeters: number;
  geometry: LatLng[];
  debug: {
    seed: number;
    points: number;
    distanceDeltaMeters: number;
    withinTolerance: boolean;
    qualityPenalty: number;
    hairpins: number;
    tinyLoops: number;
    backtracks: number;
    stateRoadMeters: number;
    roadMeters: number;
    noisyMeters: number;
    trafficPenalty: number;
    unsafeRoads: boolean;
    elevationScore: number;
    directionBucket: number;
    directionPenalty: number;
    outAndBackRatio: number;
    roundness: number;
    angularCoverage: number;
    minRadiusRatio: number;
    centerCrossPenalty: number;
  };
};

const ROUND_TRIP_SEEDS = [
  11, 29, 47, 71, 89, 113, 137, 163,
  191, 223, 257, 293, 331, 373, 419, 467,
  523, 587, 653, 727,
];

const ROUND_TRIP_BATCH_SIZE = 2;

function pointsForDistance(targetMeters: number): number {
  if (targetMeters < 8_000) return 3;
  if (targetMeters < 16_000) return 4;
  if (targetMeters < 28_000) return 5;
  return 6;
}

function bearing(a: LatLng, b: LatLng): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function angleDelta(a: number, b: number): number {
  const delta = Math.abs(a - b) % 360;
  return delta > 180 ? 360 - delta : delta;
}

function routeQuality(route: RouteProviderResult, start: LatLng, targetMeters: number) {
  const points = route.geometry;
  let hairpins = 0;
  let tinyLoops = 0;
  let backtracks = 0;
  const cumulative = [0];

  for (let i = 1; i < points.length; i += 1) {
    cumulative[i] = cumulative[i - 1] + haversineMeters(points[i - 1], points[i]);
  }

  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = haversineMeters(points[i - 1], points[i]);
    const next = haversineMeters(points[i], points[i + 1]);
    if (prev < 12 || next < 12) continue;

    const turn = angleDelta(bearing(points[i - 1], points[i]), bearing(points[i], points[i + 1]));
    const shortcut = haversineMeters(points[i - 1], points[i + 1]);
    if (turn > 145 && shortcut < Math.max(45, (prev + next) * 0.45)) hairpins += 1;
  }

  const step = Math.max(1, Math.floor(points.length / 220));
  for (let i = 0; i < points.length; i += step) {
    for (let j = i + Math.max(8, step * 4); j < points.length - 1; j += step) {
      if (i === 0 && j > points.length - 10) continue;
      const direct = haversineMeters(points[i], points[j]);
      if (direct > 45) continue;

      const along = cumulative[j] - cumulative[i];
      if (along >= 80 && along <= 700) tinyLoops += 1;
      if (along >= 120 && along <= 1_200) backtracks += 1;
      if (along >= 80 && along <= 1_200) j += Math.max(8, step * 6);
    }
  }

  // The same hard loop-shape gate the familiarity engine applies. Without it
  // this fallback path would happily hand back an out-and-back, which is the
  // one thing a "loop from A back to A" must never be.
  const shape = assessLoopShape(points, start, targetMeters);

  return {
    hairpins,
    tinyLoops,
    backtracks,
    ...evaluateTrafficSafety(route),
    shape,
    geometryPenalty:
      hairpins * 18 + tinyLoops * 28 + backtracks * 12 + Math.round(shape.outAndBackRatio * 200),
    geometryReject: hairpins >= 4 || tinyLoops >= 2 || backtracks >= 4 || !shape.ok,
    loopShapeReject: !shape.ok,
  };
}

function elevationScore(elevationGainMeters: number, targetDistanceKm: number, preference: RoundTripSuggestionInput["elevationPreference"]) {
  if (preference === "any") return 0;
  const gainPerKm = elevationGainMeters / Math.max(1, targetDistanceKm);
  if (preference === "hilly") return Math.min(80, gainPerKm * 2.5);
  return -Math.min(80, gainPerKm * 2.5);
}

function shiftedSeeds(seeds: number[], directionShift = 0): number[] {
  const shift = Math.abs(Math.floor(directionShift)) % 4;
  if (shift === 0) return seeds;

  const groups = [0, 1, 2, 3].map((group) => seeds.filter((_, index) => index % 4 === group));
  return [...groups[shift], ...groups[(shift + 1) % 4], ...groups[(shift + 2) % 4], ...groups[(shift + 3) % 4]];
}

function directionBucketFromStart(start: LatLng, points: LatLng[]): number {
  let farthest = points[0] ?? start;
  let farthestDistance = 0;

  for (const point of points) {
    const distance = haversineMeters(start, point);
    if (distance > farthestDistance) {
      farthest = point;
      farthestDistance = distance;
    }
  }

  const bucket = Math.round(bearing(start, farthest) / 90) % 4;
  return Number.isFinite(bucket) ? bucket : 0;
}

function directionPenalty(bucket: number, directionShift = 0): number {
  const desired = Math.abs(Math.floor(directionShift)) % 4;
  const diff = Math.abs(bucket - desired);
  return Math.min(diff, 4 - diff) * 180;
}

export async function generateOpenRouteServiceRoundTrip(
  input: RoundTripSuggestionInput,
): Promise<{
  routes: RoundTripSuggestionResult[];
  /** Right length and safe, but there-and-back. Never mixed into `routes`. */
  outAndBacks: RoundTripSuggestionResult[];
  rejectedCount: number;
  unsafeRejectedCount: number;
}> {
  const provider = new OpenRouteServiceProvider(process.env.OPENROUTESERVICE_API_KEY ?? "");
  const targetMeters = input.targetDistanceKm * 1000;
  const toleranceMeters = (input.toleranceKm ?? 0.5) * 1000;
  const alternatives = input.alternatives ?? 3;
  const deadlineAt = input.deadlineAt ?? Number.POSITIVE_INFINITY;
  const accepted: RoundTripSuggestionResult[] = [];
  const closest: RoundTripSuggestionResult[] = [];
  /** Right length, safe, routed — but a there-and-back. The bottom tier. */
  const outAndBacks: RoundTripSuggestionResult[] = [];
  let rejectedCount = 0;
  let unsafeRejectedCount = 0;
  let outOfTime = false;
  const points = pointsForDistance(targetMeters);
  const seeds = shiftedSeeds(ROUND_TRIP_SEEDS, input.directionShift);
  const phases: Array<{
    requestMode: "preferred" | "basic" | "basic-no-elevation";
    seeds: number[];
  }> = [
    { requestMode: "preferred", seeds: seeds.slice(0, 8) },
    { requestMode: "basic", seeds: seeds.slice(0, 8) },
    { requestMode: "basic-no-elevation", seeds: seeds.slice(0, 4) },
  ];

  for (const phase of phases) {
    let phaseHadResponse = false;

    for (let i = 0; i < phase.seeds.length; i += ROUND_TRIP_BATCH_SIZE) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= MIN_BATCH_MS) {
        outOfTime = true;
        break;
      }

      const batch = phase.seeds.slice(i, i + ROUND_TRIP_BATCH_SIZE);
      const routes = await Promise.all(batch.map(async (seed) => {
        const route = await provider.roundTrip({
          start: input.start,
          targetDistanceMeters: targetMeters,
          points,
          seed,
          routeStyle: input.routeStyle,
          preferQuiet: input.preferQuiet,
          preferGreen: input.preferGreen,
          requestMode: phase.requestMode,
          timeoutMs: Number.isFinite(remaining) ? Math.max(1_000, remaining - ASSEMBLY_RESERVE_MS) : undefined,
        });

        if (!route || route.geometry.length < 2) return null;

        const distanceDeltaMeters = Math.abs(route.distanceMeters - targetMeters);
        const quality = routeQuality(route, input.start, targetMeters);
        const gain = Math.round(route.elevationGainMeters ?? 0);
        const elevScore = elevationScore(gain, input.targetDistanceKm, input.elevationPreference ?? "any");
        const directionBucket = directionBucketFromStart(input.start, route.geometry);
        const dirPenalty = directionPenalty(directionBucket, input.directionShift);

        return {
          distanceMeters: route.distanceMeters,
          elevationGainMeters: gain,
          geometry: route.geometry,
          debug: {
            seed,
            points,
            distanceDeltaMeters,
            withinTolerance: distanceDeltaMeters <= toleranceMeters,
            qualityPenalty: quality.geometryPenalty + quality.trafficPenalty,
            hairpins: quality.hairpins,
            tinyLoops: quality.tinyLoops,
            backtracks: quality.backtracks,
            stateRoadMeters: quality.stateRoadMeters,
            roadMeters: quality.roadMeters,
            noisyMeters: quality.noisyMeters,
            trafficPenalty: quality.trafficPenalty,
            unsafeRoads: quality.unsafeRoads,
            elevationScore: elevScore,
            directionBucket,
            directionPenalty: dirPenalty,
            outAndBackRatio: quality.shape.outAndBackRatio,
            roundness: quality.shape.roundness,
            angularCoverage: quality.shape.angularCoverage,
            minRadiusRatio: quality.shape.minRadiusRatio,
            centerCrossPenalty: quality.shape.centerCrossPenalty,
          },
          reject: quality.geometryReject || quality.unsafeRoads,
          // Hard gate: a shape-invalid route is not a fallback, it is not a route.
          loopShapeReject: quality.loopShapeReject,
        };
      }));

      for (const result of routes) {
        if (!result) {
          rejectedCount += 1;
          continue;
        }

        phaseHadResponse = true;
        const { reject, loopShapeReject, ...route } = result;

        // Not a loop. It never competes with one — it is held back in its own
        // bucket and only reaches the runner if no loop at all could be found,
        // labelled as a there-and-back when it does. Road safety and the right
        // length still apply: this tier relaxes the shape, nothing else.
        if (loopShapeReject) {
          rejectedCount += 1;
          if (route.debug.unsafeRoads) unsafeRejectedCount += 1;
          else if (route.debug.distanceDeltaMeters <= toleranceMeters) outAndBacks.push(route);
          continue;
        }

        closest.push(route);
        closest.sort((a, b) => {
          const scoreA = a.debug.directionPenalty + a.debug.distanceDeltaMeters + a.debug.qualityPenalty - a.debug.elevationScore;
          const scoreB = b.debug.directionPenalty + b.debug.distanceDeltaMeters + b.debug.qualityPenalty - b.debug.elevationScore;
          return scoreA - scoreB;
        });
        closest.splice(Math.max(alternatives, 4));

        if (!reject && route.debug.distanceDeltaMeters <= toleranceMeters) accepted.push(route);
        else {
          rejectedCount += 1;
          if (route.debug.unsafeRoads) unsafeRejectedCount += 1;
        }
      }

      if (accepted.length > 0) break;
    }

    if (accepted.length > 0 || phaseHadResponse || outOfTime) break;
  }

  accepted.sort((a, b) => {
    const scoreA = a.debug.directionPenalty + a.debug.distanceDeltaMeters + a.debug.qualityPenalty - a.debug.elevationScore;
    const scoreB = b.debug.directionPenalty + b.debug.distanceDeltaMeters + b.debug.qualityPenalty - b.debug.elevationScore;
    return scoreA - scoreB;
  });

  outAndBacks.sort((a, b) => a.debug.distanceDeltaMeters - b.debug.distanceDeltaMeters);

  return {
    routes: accepted.length > 0 ? accepted : closest,
    outAndBacks,
    rejectedCount,
    unsafeRejectedCount,
  };
}
