import { GeneratedRoute, LatLng, RouteSegment } from "../../types";
import { haversineMeters, normalizeLoop, pointToSegmentDistanceMeters, toSegments } from "../utils/geo";

/**
 * The hard loop-shape gate.
 *
 * "Start at A and come back to A, but it is no straight line back and forward."
 * A route that fails these is not the thing the runner asked for: an
 * out-and-back, a shape that only ever covers one bearing, or one that keeps
 * cutting back across its own start.
 *
 * These limits are **never** relaxed to produce an answer. The familiarity
 * band is the only soft constraint in the engine — see `evaluateBuiltRoute`.
 * Every path that can return a route to the client applies this same gate.
 */
export const LOOP_SHAPE_LIMITS = {
  maxOutAndBackRatio: 0.2,
  maxClosureErrorMeters: 50,
  /**
   * How much ground the loop has to enclose for its length — see `loopRoundness`.
   *
   * Measured against real openrouteservice loops from the Falkenberg start
   * point that provoked this: 0.22, 0.25, 0.45, 0.56, 0.60, 0.62. Against
   * shapes that must not pass: a literal there-and-back scores 0.000, a run
   * out and back along a parallel street 20 m away 0.03, and the 2.4 km x 100 m
   * sliver the test suite guards against 0.12.
   *
   * 0.15 sits in that gap with the nearest real loop 1.5x clear of it.
   */
  minRoundness: 0.15,
} as const;

/**
 * Roundness measures that rank loops but never reject one.
 *
 * They were hard limits, and that was the bug: `minRadiusRatio` is the *single*
 * closest sample to the loop's centre divided by the radius the loop would have
 * if it were a circle, so one street that happens to pass near the middle
 * condemns the whole route. Four of five real routes from the reported start
 * point scored 0.05-0.30 against a limit of 0.46 while retracing not one metre
 * of themselves. Real streets do not lay out circles; they still make loops.
 */
export const LOOP_SHAPE_PREFERENCES = {
  minAngularCoverage: 0.72,
  minRadiusRatio: 0.46,
  maxCenterCrossPenalty: 0.12,
} as const;

export type LoopShapeAssessment = {
  /** False means "do not return this route", on any path, for any reason. */
  ok: boolean;
  outAndBackRatio: number;
  closureErrorMeters: number;
  /** 0 for a there-and-back, 1 for a circle. The hard roundness test. */
  roundness: number;
  angularCoverage: number;
  radialStdRatio: number;
  minRadiusRatio: number;
  maxRadiusRatio: number;
  centerCrossPenalty: number;
};

export function assessLoopShape(
  geometry: LatLng[],
  start: LatLng,
  targetMeters: number,
): LoopShapeAssessment {
  const loopGeometry = normalizeLoop(geometry);
  const outAndBackRatio = computeOutAndBackRatio(toSegments(loopGeometry));
  // Measured on what the router returned, never on the normalised copy:
  // `normalizeLoop` closes the ring by appending the first point, which would
  // report every gaping loop as perfectly shut.
  const closureErrorMeters = computeClosureErrorMeters(geometry);
  const roundness = loopRoundness(loopGeometry);
  const metrics = computeLoopShapeMetrics(loopGeometry, start, targetMeters);

  const ok =
    outAndBackRatio <= LOOP_SHAPE_LIMITS.maxOutAndBackRatio &&
    closureErrorMeters <= LOOP_SHAPE_LIMITS.maxClosureErrorMeters &&
    roundness >= LOOP_SHAPE_LIMITS.minRoundness;

  return { ok, outAndBackRatio, closureErrorMeters, roundness, ...metrics };
}

/**
 * How much ground a closed route encloses, for its length.
 *
 * The isoperimetric quotient, `4πA / P²`: 1 for a circle, 0 for a line out and
 * back. It answers the owner's rule directly — *"start at A and come back to A,
 * but it is no straight line back and forward"* — because going out and coming
 * back encloses nothing, however you dress it up.
 *
 * It is also the only formulation of that rule that survives real streets. The
 * shape does not have to be round, or centred anywhere in particular, or visit
 * every compass bearing; it only has to go round *something*. And unlike
 * counting retraced segments, it still catches the sly version: out along one
 * street and back along the one behind it, which shares no segment with itself
 * and is an out-and-back all the same.
 */
export function loopRoundness(points: LatLng[]): number {
  if (points.length < 4) return 0;

  const perimeter = polylineLengthMeters(points);
  if (perimeter <= 0) return 0;

  return Math.min(1, (4 * Math.PI * enclosedAreaSquareMeters(points)) / (perimeter * perimeter));
}

/** Shoelace area on a local equirectangular projection. Metres, unsigned. */
function enclosedAreaSquareMeters(points: LatLng[]): number {
  const meanLat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const metersPerDegLat = 111_132.92;
  const metersPerDegLng = 111_319.49 * Math.cos((meanLat * Math.PI) / 180);

  let twiceArea = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    twiceArea +=
      a.lng * metersPerDegLng * (b.lat * metersPerDegLat) -
      b.lng * metersPerDegLng * (a.lat * metersPerDegLat);
  }

  return Math.abs(twiceArea / 2);
}

function polylineLengthMeters(points: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += haversineMeters(points[i - 1], points[i]);
  return total;
}

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

/**
 * How far the end of the route sits from its start. Always give this the raw
 * geometry — `normalizeLoop` output is closed by construction and would always
 * measure zero.
 */
export function computeClosureErrorMeters(points: GeneratedRoute["geometry"]): number {
  if (points.length < 2) return 0;
  return haversineMeters(points[0], points[points.length - 1]);
}

/**
 * How round the loop is, measured from the loop's own centre.
 *
 * Not from the start. A run that leaves the front door and comes back to it has
 * the door *on the ring*, never in the middle of it — measured from the door, a
 * flawless circular loop reads as radii from 0 to 2R, which scores as badly as
 * an out-and-back. Measuring from the centroid asks the question that was
 * actually meant: is this thing round, whereabouts on it the runner happens to
 * live being beside the point.
 *
 * That the route comes back to the door at all is a separate question, and
 * `computeClosureErrorMeters` answers it.
 */
export function computeLoopShapeMetrics(points: LatLng[], start: LatLng, targetMeters: number): {
  angularCoverage: number;
  radialStdRatio: number;
  minRadiusRatio: number;
  maxRadiusRatio: number;
  centerCrossPenalty: number;
} {
  const samples = samplePoints(points, Math.min(32, Math.max(10, Math.floor(points.length / 4))));
  const centre = centroidOf(samples);
  const bearings = new Set<number>();
  const radii: number[] = [];
  const expectedRadius = Math.max(120, targetMeters / (2 * Math.PI));

  for (const point of samples) {
    const radius = haversineMeters(centre, point);
    if (radius < 15) continue;
    radii.push(radius);
    bearings.add(Math.floor((bearingBetween(centre, point) + 360) % 360 / 30));
  }

  if (radii.length === 0) {
    return { angularCoverage: 0, radialStdRatio: 1, minRadiusRatio: 0, maxRadiusRatio: 0, centerCrossPenalty: 1 };
  }

  const mean = radii.reduce((sum, value) => sum + value, 0) / radii.length;
  const variance = radii.reduce((sum, value) => sum + (value - mean) ** 2, 0) / radii.length;
  const std = Math.sqrt(variance);

  const centerCrosses = samples.filter((point) => haversineMeters(point, centre) < expectedRadius * 0.35).length;

  return {
    angularCoverage: bearings.size / 12,
    radialStdRatio: std / Math.max(mean, 1),
    minRadiusRatio: Math.min(...radii) / expectedRadius,
    maxRadiusRatio: Math.max(...radii) / expectedRadius,
    centerCrossPenalty: centerCrosses / Math.max(1, samples.length),
  };
}

/** The middle of the loop. Small areas, so a plain mean is close enough. */
function centroidOf(points: LatLng[]): LatLng {
  if (points.length === 0) return { lat: 0, lng: 0 };
  let lat = 0;
  let lng = 0;
  for (const point of points) {
    lat += point.lat;
    lng += point.lng;
  }
  return { lat: lat / points.length, lng: lng / points.length };
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
  /** Optional so callers that only have the older metrics still compile. */
  roundness?: number;
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
  // The rounder of two otherwise equal loops is the better run. A preference,
  // deliberately worth less than distance: it ranks, it does not reject.
  const roundnessBonus = Math.min(1, Math.max(0, params.roundness ?? 0)) * 18;

  const score =
    100 -
    distancePenalty * 70 -
    familiarityPenalty * 24 -
    outAndBackPenalty * 70 -
    closurePenalty * 12 -
    angularPenalty * 26 -
    radialPenalty * 10 -
    centerRevisitPenalty * 20 -
    tooWidePenalty * 12 +
    roundnessBonus;

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
      roundnessBonus,
    },
  };
}
