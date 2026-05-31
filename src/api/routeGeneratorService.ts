import { generateRoutes } from "../engine/generateRoute";
import { OpenRouteServiceProvider } from "../engine/providers/openRouteService";
import { GenerateRouteInput, LatLng } from "../types";
import { haversineMeters } from "../engine/utils/geo";

export async function generateTrainingRoutes(input: GenerateRouteInput) {
  const provider = new OpenRouteServiceProvider(process.env.OPENROUTESERVICE_API_KEY ?? "");
  return generateRoutes(provider, input);
}

export type RoundTripSuggestionInput = {
  start: LatLng;
  targetDistanceKm: number;
  toleranceKm?: number;
  alternatives?: number;
  routeStyle?: "road" | "mixed" | "trail";
  preferQuiet?: boolean;
  preferGreen?: boolean;
  elevationPreference?: "any" | "hilly" | "flat";
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
    elevationScore: number;
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

function routeQuality(points: LatLng[]) {
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

  return {
    hairpins,
    tinyLoops,
    backtracks,
    penalty: hairpins * 18 + tinyLoops * 28 + backtracks * 12,
    reject: hairpins >= 4 || tinyLoops >= 2 || backtracks >= 4,
  };
}

function elevationScore(elevationGainMeters: number, targetDistanceKm: number, preference: RoundTripSuggestionInput["elevationPreference"]) {
  if (preference === "any") return 0;
  const gainPerKm = elevationGainMeters / Math.max(1, targetDistanceKm);
  if (preference === "hilly") return Math.min(80, gainPerKm * 2.5);
  return -Math.min(80, gainPerKm * 2.5);
}

export async function generateOpenRouteServiceRoundTrip(
  input: RoundTripSuggestionInput,
): Promise<{ routes: RoundTripSuggestionResult[]; rejectedCount: number }> {
  const provider = new OpenRouteServiceProvider(process.env.OPENROUTESERVICE_API_KEY ?? "");
  const targetMeters = input.targetDistanceKm * 1000;
  const toleranceMeters = (input.toleranceKm ?? 0.5) * 1000;
  const alternatives = input.alternatives ?? 3;
  const accepted: RoundTripSuggestionResult[] = [];
  const closest: RoundTripSuggestionResult[] = [];
  let rejectedCount = 0;
  const points = pointsForDistance(targetMeters);
  const phases: Array<{
    requestMode: "preferred" | "basic" | "basic-no-elevation";
    seeds: number[];
  }> = [
    { requestMode: "preferred", seeds: ROUND_TRIP_SEEDS.slice(0, 8) },
    { requestMode: "basic", seeds: ROUND_TRIP_SEEDS.slice(0, 8) },
    { requestMode: "basic-no-elevation", seeds: ROUND_TRIP_SEEDS.slice(0, 4) },
  ];

  for (const phase of phases) {
    let phaseHadResponse = false;

    for (let i = 0; i < phase.seeds.length; i += ROUND_TRIP_BATCH_SIZE) {
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
        });

        if (!route || route.geometry.length < 2) return null;

        const distanceDeltaMeters = Math.abs(route.distanceMeters - targetMeters);
        const quality = routeQuality(route.geometry);
        const gain = Math.round(route.elevationGainMeters ?? 0);
        const elevScore = elevationScore(gain, input.targetDistanceKm, input.elevationPreference ?? "any");

        return {
          distanceMeters: route.distanceMeters,
          elevationGainMeters: gain,
          geometry: route.geometry,
          debug: {
            seed,
            points,
            distanceDeltaMeters,
            withinTolerance: distanceDeltaMeters <= toleranceMeters,
            qualityPenalty: quality.penalty,
            hairpins: quality.hairpins,
            tinyLoops: quality.tinyLoops,
            backtracks: quality.backtracks,
            elevationScore: elevScore,
          },
          reject: quality.reject,
        };
      }));

      for (const result of routes) {
        if (!result) {
          rejectedCount += 1;
          continue;
        }

        phaseHadResponse = true;
        const { reject, ...route } = result;
        closest.push(route);
        closest.sort((a, b) => {
          const scoreA = a.debug.distanceDeltaMeters + a.debug.qualityPenalty - a.debug.elevationScore;
          const scoreB = b.debug.distanceDeltaMeters + b.debug.qualityPenalty - b.debug.elevationScore;
          return scoreA - scoreB;
        });
        closest.splice(Math.max(alternatives, 4));

        if (!reject && route.debug.distanceDeltaMeters <= toleranceMeters) accepted.push(route);
        else rejectedCount += 1;
      }

      if (accepted.length > 0) break;
    }

    if (accepted.length > 0 || phaseHadResponse) break;
  }

  accepted.sort((a, b) => {
    const scoreA = a.debug.distanceDeltaMeters + a.debug.qualityPenalty - a.debug.elevationScore;
    const scoreB = b.debug.distanceDeltaMeters + b.debug.qualityPenalty - b.debug.elevationScore;
    return scoreA - scoreB;
  });

  return {
    routes: accepted.length > 0 ? accepted : closest,
    rejectedCount,
  };
}
