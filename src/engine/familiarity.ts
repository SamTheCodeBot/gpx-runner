import { LatLng, RouteSegment } from "../types";
import { densifyPolyline, pointToSegmentDistanceMeters, simplifyByDistance, toSegments } from "./utils/geo";
import { addSegmentToGrid, createSegmentGrid, nearbyValues, type SegmentGrid } from "./utils/spatialGrid";

/**
 * How much of a candidate route the runner has already run.
 *
 * Both building the index and scoring a route are lookups against a uniform
 * spatial grid. A brute-force scan is quadratic, and an ultra runner's history
 * around one town is tens of thousands of segments — enough to hang a request.
 */

/** Grid cell size. Must stay comfortably above the widest match radius below. */
export const FAMILIARITY_CELL_METERS = 40;
const MATCH_RADIUS_METERS = 35;
const DUPLICATE_RADIUS_METERS = 10;

export type FamiliarityIndex = {
  familiarSegments: RouteSegment[];
  /** Cell contents are indices into `familiarSegments`. */
  grid: SegmentGrid<number>;
};

/** Segment indices in the 3x3 cell neighbourhood around a point. */
function nearbySegmentIndices(grid: SegmentGrid<number>, point: LatLng): number[] {
  // One ring is enough here and nowhere else: every radius this file matches
  // against is narrower than a cell.
  return nearbyValues(grid, point);
}

export function buildFamiliarityIndex(trackCollections: LatLng[][]): FamiliarityIndex {
  const rawSegments = trackCollections.flatMap((track) =>
    toSegments(simplifyByDistance(track, 18)).filter((s) => s.distanceMeters >= 8),
  );

  const grid = createSegmentGrid<number>(FAMILIARITY_CELL_METERS, rawSegments[0]?.from);
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

    addSegmentToGrid(grid, segment.from, segment.to, familiarSegments.length);
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

  for (const sample of samples) matches += knownnessAt(sample, index);

  return samples.length === 0 ? 0 : Math.max(0, Math.min(1, matches / samples.length));
}

/**
 * How well the runner knows one spot: 1 for ground he has run, 0 for ground he
 * has never been near.
 *
 * The same ladder `familiarityWeight` scores a route with, exposed as a single
 * point query so the search can ask the question *before* paying a provider to
 * draw anything. One definition of "familiar", used both to steer and to judge
 * — if these two ever drifted apart the engine would be aiming at one thing and
 * reporting another.
 */
export function knownnessAt(point: LatLng, index: FamiliarityIndex): number {
  const distance = nearestFamiliarDistanceMeters(point, index);

  if (distance <= 10) return 1;
  if (distance <= 16) return 0.8;
  if (distance <= 24) return 0.45;
  if (distance <= MATCH_RADIUS_METERS) return 0.15;
  return 0;
}

/**
 * The runner's history, read backwards: how much of a proposed line is ground
 * he already knows, judged on the straight polyline rather than on routed
 * geometry.
 *
 * This is a *prediction*, not a measurement — the provider will not follow the
 * proposal exactly, so the number the runner is finally shown always comes from
 * `computeFamiliarityRatio` on what came back. Its job is only to decide which
 * handful of proposals are worth one of the eight routing calls a request may
 * spend, and for that it costs nothing but arithmetic.
 */
export function estimatePathKnownness(
  points: LatLng[],
  index: FamiliarityIndex,
  sampleMeters = 40,
): number {
  if (points.length < 2 || index.familiarSegments.length === 0) return 0;

  const samples = densifyPolyline(points, sampleMeters);
  if (samples.length === 0) return 0;

  let total = 0;
  for (const sample of samples) total += knownnessAt(sample, index);
  return Math.max(0, Math.min(1, total / samples.length));
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
