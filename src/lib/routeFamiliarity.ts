import type { GPXRoute } from "@/app/types";
import type { LatLng } from "@/types";
import { buildFamiliarityIndex, computeFamiliarityRatio } from "@/engine/familiarity";
import { densifyPolyline, pointToSegmentDistanceMeters, simplifyByDistance, toSegments } from "@/engine/utils/geo";

export type RouteFamiliarityLabel = "unfamiliar" | "partly familiar" | "familiar";

export type RouteFamiliarityResult = {
  percent: number;
  ratio: number;
  label: RouteFamiliarityLabel;
  matchedDistanceMeters: number;
  totalDistanceMeters: number;
  segments: RouteFamiliaritySegment[];
};

export type RouteFamiliaritySegment = {
  coordinates: [[number, number], [number, number]];
  ratio: number;
  label: RouteFamiliarityLabel;
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
    segments: candidateSegments.map((segment) => {
      const segmentRatio = segmentFamiliarityRatio(segment, index.familiarSegments);
      const segmentPercent = Math.round(segmentRatio * 100);
      return {
        coordinates: [
          [segment.from.lng, segment.from.lat],
          [segment.to.lng, segment.to.lat],
        ],
        ratio: segmentRatio,
        label: familiarityLabel(segmentPercent),
      };
    }),
  };
}

function segmentFamiliarityRatio(
  segment: { from: LatLng; to: LatLng },
  familiarSegments: Array<{ from: LatLng; to: LatLng }>,
): number {
  const samples = densifyPolyline([segment.from, segment.to], 12);
  let matches = 0;

  for (const sample of samples) {
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const familiar of familiarSegments) {
      const distance = pointToSegmentDistanceMeters(sample, familiar.from, familiar.to);
      if (distance < bestDistance) bestDistance = distance;
      if (bestDistance <= 8) break;
    }

    if (bestDistance <= 10) matches += 1;
    else if (bestDistance <= 16) matches += 0.8;
    else if (bestDistance <= 24) matches += 0.45;
    else if (bestDistance <= 35) matches += 0.15;
  }

  return samples.length === 0 ? 0 : Math.max(0, Math.min(1, matches / samples.length));
}
