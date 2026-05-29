import type { GPXRoute } from "@/app/types";
import type { LatLng } from "@/types";
import { buildFamiliarityIndex, computeFamiliarityRatio } from "@/engine/familiarity";
import { simplifyByDistance, toSegments } from "@/engine/utils/geo";

export type RouteFamiliarityLabel = "unfamiliar" | "partly familiar" | "familiar";

export type RouteFamiliarityResult = {
  percent: number;
  ratio: number;
  label: RouteFamiliarityLabel;
  matchedDistanceMeters: number;
  totalDistanceMeters: number;
};

function toLatLngTrack(route: Pick<GPXRoute, "coordinates">): LatLng[] {
  return route.coordinates
    .map(([lng, lat]) => ({ lat, lng }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
}

export function familiarityLabel(percent: number): RouteFamiliarityLabel {
  if (percent < 20) return "unfamiliar";
  if (percent > 70) return "familiar";
  return "partly familiar";
}

export function calculateRouteFamiliarity(
  candidateRoute: Pick<GPXRoute, "coordinates" | "distance">,
  previousRoutes: Array<Pick<GPXRoute, "coordinates">>,
): RouteFamiliarityResult {
  const candidateTrack = toLatLngTrack(candidateRoute);
  const previousTracks = previousRoutes
    .map(toLatLngTrack)
    .filter((track) => track.length >= 2);

  const candidateSegments = toSegments(simplifyByDistance(candidateTrack, 18)).filter(
    (segment) => segment.distanceMeters >= 8,
  );
  const index = buildFamiliarityIndex(previousTracks);
  const ratio = computeFamiliarityRatio(candidateSegments, index);
  const percent = Math.round(ratio * 100);
  const totalDistanceMeters =
    candidateRoute.distance > 0
      ? candidateRoute.distance
      : candidateSegments.reduce((sum, segment) => sum + segment.distanceMeters, 0);

  return {
    percent,
    ratio,
    label: familiarityLabel(percent),
    matchedDistanceMeters: Math.round(totalDistanceMeters * ratio),
    totalDistanceMeters: Math.round(totalDistanceMeters),
  };
}
