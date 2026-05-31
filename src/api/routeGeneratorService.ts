import { generateRoutes } from "../engine/generateRoute";
import { OpenRouteServiceProvider } from "../engine/providers/openRouteService";
import { GenerateRouteInput, LatLng } from "../types";

export async function generateTrainingRoutes(input: GenerateRouteInput) {
  const provider = new OpenRouteServiceProvider(process.env.OPENROUTESERVICE_API_KEY ?? "");
  return generateRoutes(provider, input);
}

export type RoundTripSuggestionInput = {
  start: LatLng;
  targetDistanceKm: number;
  toleranceKm?: number;
  alternatives?: number;
};

export type RoundTripSuggestionResult = {
  distanceMeters: number;
  geometry: LatLng[];
  debug: {
    seed: number;
    points: number;
    distanceDeltaMeters: number;
    withinTolerance: boolean;
  };
};

const ROUND_TRIP_SEEDS = [
  11, 29, 47, 71, 89, 113, 137, 163,
  191, 223, 257, 293, 331, 373, 419, 467,
  523, 587, 653, 727, 809, 887, 971, 1061,
];

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

  for (const seed of ROUND_TRIP_SEEDS) {
    const points = targetMeters < 4_000 ? 4 : targetMeters < 12_000 ? 5 : 6;
    const route = await provider.roundTrip({
      start: input.start,
      targetDistanceMeters: targetMeters,
      points,
      seed,
    });

    if (!route || route.geometry.length < 2) {
      rejectedCount += 1;
      continue;
    }

    const distanceDeltaMeters = Math.abs(route.distanceMeters - targetMeters);
    const result: RoundTripSuggestionResult = {
      distanceMeters: route.distanceMeters,
      geometry: route.geometry,
      debug: {
        seed,
        points,
        distanceDeltaMeters,
        withinTolerance: distanceDeltaMeters <= toleranceMeters,
      },
    };

    closest.push(result);
    closest.sort((a, b) => a.debug.distanceDeltaMeters - b.debug.distanceDeltaMeters);
    closest.splice(alternatives);

    if (distanceDeltaMeters <= toleranceMeters) {
      accepted.push(result);
      if (accepted.length >= alternatives) break;
    } else {
      rejectedCount += 1;
    }
  }

  return {
    routes: accepted.length > 0 ? accepted : closest,
    rejectedCount,
  };
}
