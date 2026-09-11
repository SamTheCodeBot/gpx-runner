import { LatLng, RouteSegment } from "../types";
import { densifyPolyline, pointToSegmentDistanceMeters, simplifyByDistance, toSegments } from "./utils/geo";

/**
 * How much of a candidate route the runner has already run.
 *
 * Both building the index and scoring a route are lookups against a uniform
 * spatial grid. A brute-force scan is quadratic, and an ultra runner's history
 * around one town is tens of thousands of segments — enough to hang a request.
 */

/** Grid cell size. Must stay comfortably above the widest match radius below. */
const CELL_METERS = 40;
const MATCH_RADIUS_METERS = 35;
const DUPLICATE_RADIUS_METERS = 10;

export type FamiliarityIndex = {
  familiarSegments: RouteSegment[];
  grid: SegmentGrid;
};

type SegmentGrid = {
  cells: Map<string, number[]>;
  latStep: number;
  lngStep: number;
};

function createGrid(reference: LatLng | undefined): SegmentGrid {
  const latStep = CELL_METERS / 111_320;
  const cosLat = Math.cos(((reference?.lat ?? 0) * Math.PI) / 180);
  const lngStep = CELL_METERS / Math.max(1, 111_320 * Math.max(0.05, Math.abs(cosLat)));
  return { cells: new Map(), latStep, lngStep };
}

function cellKey(grid: SegmentGrid, point: LatLng): string {
  return `${Math.floor(point.lat / grid.latStep)}:${Math.floor(point.lng / grid.lngStep)}`;
}

/** Every cell a segment passes through, sampled finely enough not to skip one. */
function segmentCells(grid: SegmentGrid, segment: RouteSegment): string[] {
  const steps = Math.max(1, Math.ceil(segment.distanceMeters / (CELL_METERS / 2)));
  const keys = new Set<string>();

  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    keys.add(
      cellKey(grid, {
        lat: segment.from.lat + (segment.to.lat - segment.from.lat) * t,
        lng: segment.from.lng + (segment.to.lng - segment.from.lng) * t,
      }),
    );
  }

  return Array.from(keys);
}

function addSegment(grid: SegmentGrid, segment: RouteSegment, index: number): void {
  for (const key of segmentCells(grid, segment)) {
    const bucket = grid.cells.get(key);
    if (bucket) bucket.push(index);
    else grid.cells.set(key, [index]);
  }
}

/** Segment indices in the 3x3 cell neighbourhood around a point. */
function nearbySegmentIndices(grid: SegmentGrid, point: LatLng): number[] {
  const latCell = Math.floor(point.lat / grid.latStep);
  const lngCell = Math.floor(point.lng / grid.lngStep);
  const found: number[] = [];

  for (let dLat = -1; dLat <= 1; dLat += 1) {
    for (let dLng = -1; dLng <= 1; dLng += 1) {
      const bucket = grid.cells.get(`${latCell + dLat}:${lngCell + dLng}`);
      if (bucket) found.push(...bucket);
    }
  }

  return found;
}

export function buildFamiliarityIndex(trackCollections: LatLng[][]): FamiliarityIndex {
  const rawSegments = trackCollections.flatMap((track) =>
    toSegments(simplifyByDistance(track, 18)).filter((s) => s.distanceMeters >= 8),
  );

  const grid = createGrid(rawSegments[0]?.from);
  const familiarSegments: RouteSegment[] = [];

  for (const segment of rawSegments) {
    const duplicate = nearbySegmentIndices(grid, segment.from).some((index) => {
      const existing = familiarSegments[index];
      return (
        pointToSegmentDistanceMeters(segment.from, existing.from, existing.to) <= DUPLICATE_RADIUS_METERS &&
        pointToSegmentDistanceMeters(segment.to, existing.from, existing.to) <= DUPLICATE_RADIUS_METERS
      );
    });

    if (duplicate) continue;

    addSegment(grid, segment, familiarSegments.length);
    familiarSegments.push(segment);
  }

  return { familiarSegments, grid };
}

export function computeFamiliarityRatio(routeSegments: RouteSegment[], index: FamiliarityIndex): number {
  if (routeSegments.length === 0) return 0;
  let familiarDistance = 0;
  let totalDistance = 0;

  for (const segment of routeSegments) {
    totalDistance += segment.distanceMeters;
    familiarDistance += segment.distanceMeters * familiarityWeight(segment, index);
  }

  if (totalDistance === 0) return 0;
  return Math.max(0, Math.min(1, familiarDistance / totalDistance));
}

/** How much of one candidate segment is covered by logged tracks (0..1). */
export function familiarityWeight(segment: RouteSegment, index: FamiliarityIndex): number {
  const samples = densifyPolyline([segment.from, segment.to], 12);
  let matches = 0;

  for (const sample of samples) {
    const bestDistance = nearestFamiliarDistanceMeters(sample, index);

    if (bestDistance <= 10) matches += 1;
    else if (bestDistance <= 16) matches += 0.8;
    else if (bestDistance <= 24) matches += 0.45;
    else if (bestDistance <= MATCH_RADIUS_METERS) matches += 0.15;
  }

  return samples.length === 0 ? 0 : Math.max(0, Math.min(1, matches / samples.length));
}

export function nearestFamiliarDistanceMeters(point: LatLng, index: FamiliarityIndex): number {
  let best = Number.POSITIVE_INFINITY;

  for (const segmentIndex of nearbySegmentIndices(index.grid, point)) {
    const familiar = index.familiarSegments[segmentIndex];
    const distance = pointToSegmentDistanceMeters(point, familiar.from, familiar.to);
    if (distance < best) best = distance;
    if (best <= 8) break;
  }

  return best;
}
