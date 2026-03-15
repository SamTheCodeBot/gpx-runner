import { GeneratedRoute, LatLng, RouteSegment } from "../../types";
import { haversineMeters, pointToSegmentDistanceMeters } from "../utils/geo";

export function computeDistancePenalty(distanceMeters: number, targetMeters: number): number {
  return Math.abs(distanceMeters - targetMeters) / Math.max(targetMeters, 1);
}

export function computeOutAndBackRatio(segments: RouteSegment[]): number {
  if (segments.length < 2) return 0;

  let repeatedDistance = 0;
  let totalDistance = 0;
  const seenUndirected = new Map<string, number>();

  for (const segment of segments) {
    totalDistance += segment.distanceMeters;
    const key = segmentKey(segment);
    const previous = seenUndirected.get(key) ?? 0;
    if (previous > 0) repeatedDistance += segment.distanceMeters;
    seenUndirected.set(key, previous + 1);
  }

  return totalDistance === 0 ? 0 : Math.min(1, repeatedDistance / totalDistance);
}

function segmentKey(segment: RouteSegment): string {
  const a = `${segment.from.lat.toFixed(4)}:${segment.from.lng.toFixed(4)}`;
  const b = `${segment.to.lat.toFixed(4)}:${segment.to.lng.toFixed(4)}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function computeClosureErrorMeters(points: GeneratedRoute["geometry"]): number {
  if (points.length < 2) return 0;
  return haversineMeters(points[0], points[points.length - 1]);
}

export function computeLoopShapeMetrics(points: LatLng[], start: LatLng, targetMeters: number): {
  angularCoverage: number;
  radialStdRatio: number;
  minRadiusRatio: number;
  maxRadiusRatio: number;
  centerCrossPenalty: number;
} {
  const samples = samplePoints(points, Math.min(32, Math.max(10, Math.floor(points.length / 4))));
  const bearings = new Set<number>();
  const radii: number[] = [];
  const expectedRadius = Math.max(120, targetMeters / (2 * Math.PI));

  for (const point of samples) {
    const radius = haversineMeters(start, point);
    if (radius < 15) continue;
    radii.push(radius);
    bearings.add(Math.floor((bearingBetween(start, point) + 360) % 360 / 30));
  }

  if (radii.length === 0) {
    return { angularCoverage: 0, radialStdRatio: 1, minRadiusRatio: 0, maxRadiusRatio: 0, centerCrossPenalty: 1 };
  }

  const mean = radii.reduce((sum, value) => sum + value, 0) / radii.length;
  const variance = radii.reduce((sum, value) => sum + (value - mean) ** 2, 0) / radii.length;
  const std = Math.sqrt(variance);

  const centerCrosses = samples.filter((point) => haversineMeters(point, start) < expectedRadius * 0.35).length;

  return {
    angularCoverage: bearings.size / 12,
    radialStdRatio: std / Math.max(mean, 1),
    minRadiusRatio: Math.min(...radii) / expectedRadius,
    maxRadiusRatio: Math.max(...radii) / expectedRadius,
    centerCrossPenalty: centerCrosses / Math.max(1, samples.length),
  };
}

function samplePoints(points: LatLng[], desired: number): LatLng[] {
  if (points.length <= desired) return points;
  const step = Math.max(1, Math.floor(points.length / desired));
  const sampled: LatLng[] = [];

  for (let i = 0; i < points.length; i += step) sampled.push(points[i]);
  const last = points[points.length - 1];
  if (sampled[sampled.length - 1] !== last) sampled.push(last);
  return sampled;
}

function bearingBetween(a: LatLng, b: LatLng): number {
  const y = Math.sin(toRadians(b.lng - a.lng)) * Math.cos(toRadians(b.lat));
  const x =
    Math.cos(toRadians(a.lat)) * Math.sin(toRadians(b.lat)) -
    Math.sin(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.cos(toRadians(b.lng - a.lng));
  return (Math.atan2(y, x) * 180) / Math.PI;
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

export function scoreRoute(params: {
  distanceMeters: number;
  targetMeters: number;
  familiarityRatio: number;
  targetFamiliarityRange: { min: number; max: number };
  outAndBackRatio: number;
  closureErrorMeters: number;
  angularCoverage: number;
  radialStdRatio: number;
  minRadiusRatio: number;
  maxRadiusRatio: number;
  centerCrossPenalty: number;
}): { score: number; debug: Record<string, number> } {
  const distancePenalty = computeDistancePenalty(params.distanceMeters, params.targetMeters);
  const familiarityCenter = (params.targetFamiliarityRange.min + params.targetFamiliarityRange.max) / 2;
  const familiarityPenalty = Math.abs(params.familiarityRatio - familiarityCenter);
  const outAndBackPenalty = params.outAndBackRatio;
  const closurePenalty = Math.min(1, params.closureErrorMeters / 40);
  const angularPenalty = 1 - Math.min(1, params.angularCoverage);
  const radialPenalty = Math.min(1, params.radialStdRatio / 0.32);
  const centerRevisitPenalty = Math.max(0, 0.85 - params.minRadiusRatio) + params.centerCrossPenalty;
  const tooWidePenalty = Math.max(0, params.maxRadiusRatio - 1.85);

  const score =
    100 -
    distancePenalty * 70 -
    familiarityPenalty * 24 -
    outAndBackPenalty * 70 -
    closurePenalty * 12 -
    angularPenalty * 26 -
    radialPenalty * 10 -
    centerRevisitPenalty * 20 -
    tooWidePenalty * 12;

  return {
    score,
    debug: {
      distancePenalty,
      familiarityPenalty,
      outAndBackPenalty,
      closurePenalty,
      angularPenalty,
      radialPenalty,
      centerRevisitPenalty,
      tooWidePenalty,
    },
  };
}
