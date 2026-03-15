import { LatLng, RouteSegment } from "../types";
import { densifyPolyline, pointToSegmentDistanceMeters, simplifyByDistance, toSegments } from "./utils/geo";

export type FamiliarityIndex = {
  familiarSegments: RouteSegment[];
};

export function buildFamiliarityIndex(trackCollections: LatLng[][]): FamiliarityIndex {
  const rawSegments = trackCollections.flatMap((track) =>
    toSegments(simplifyByDistance(track, 18)).filter((s) => s.distanceMeters >= 8),
  );
  const familiarSegments: RouteSegment[] = [];

  for (const segment of rawSegments) {
    const duplicate = familiarSegments.some(
      (existing) =>
        pointToSegmentDistanceMeters(segment.from, existing.from, existing.to) <= 10 &&
        pointToSegmentDistanceMeters(segment.to, existing.from, existing.to) <= 10,
    );

    if (!duplicate) familiarSegments.push(segment);
  }

  return { familiarSegments };
}

export function computeFamiliarityRatio(routeSegments: RouteSegment[], index: FamiliarityIndex): number {
  if (routeSegments.length === 0) return 0;
  let familiarDistance = 0;
  let totalDistance = 0;

  for (const segment of routeSegments) {
    totalDistance += segment.distanceMeters;
    familiarDistance += segment.distanceMeters * familiarityWeight(segment, index.familiarSegments);
  }

  if (totalDistance === 0) return 0;
  return Math.max(0, Math.min(1, familiarDistance / totalDistance));
}

function familiarityWeight(segment: RouteSegment, familiarSegments: RouteSegment[]): number {
  const samples = densifyPolyline([segment.from, segment.to], 12);
  let matches = 0;

  for (const sample of samples) {
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const familiar of familiarSegments) {
      const d = pointToSegmentDistanceMeters(sample, familiar.from, familiar.to);
      if (d < bestDistance) bestDistance = d;
      if (bestDistance <= 8) break;
    }

    if (bestDistance <= 10) matches += 1;
    else if (bestDistance <= 16) matches += 0.8;
    else if (bestDistance <= 24) matches += 0.45;
    else if (bestDistance <= 35) matches += 0.15;
  }

  return samples.length === 0 ? 0 : Math.max(0, Math.min(1, matches / samples.length));
}
