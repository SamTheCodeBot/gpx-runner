import { LatLng } from "../../types";
import { haversineMeters, destinationPoint } from "../utils/geo";

/**
 * The area a street completion project covers.
 *
 * There is exactly one shape in this feature: a polygon. A pin with a radius is
 * a polygon whose ring happens to be a circle; an OSM administrative boundary
 * is a polygon whose ring came from a relation. Nothing downstream — inventory,
 * snapshot, clipping, progress — is allowed to ask which one it was looking at,
 * because the moment those two paths diverge the maths behind the progress bar
 * stops being one thing that can be trusted and tested.
 *
 * `source` exists only so the UI can redraw the control the owner used and so a
 * radius can be nudged later. It carries no geometry that is not already in the
 * ring.
 */

export type ScopeSource =
  | { kind: "circle"; center: LatLng; radiusMeters: number }
  | { kind: "boundary"; osmId: number; osmType: "relation" | "way"; name: string; adminLevel?: number };

export type StreetScope = {
  /** Closed ring in order; the closing point is implicit, never repeated. */
  ring: LatLng[];
  source: ScopeSource;
};

/** Enough segments that a 5 km circle is within a metre of a true circle. */
const CIRCLE_STEPS = 96;

export function circleScope(center: LatLng, radiusMeters: number, steps = CIRCLE_STEPS): StreetScope {
  const ring: LatLng[] = [];
  for (let i = 0; i < steps; i += 1) {
    ring.push(destinationPoint(center, (360 * i) / steps, radiusMeters));
  }
  return { ring, source: { kind: "circle", center, radiusMeters } };
}

export function boundaryScope(
  ring: LatLng[],
  source: Extract<ScopeSource, { kind: "boundary" }>,
): StreetScope {
  return { ring: closeOpenRing(ring), source };
}

/** A ring that repeats its first point at the end is stored without the repeat. */
function closeOpenRing(ring: LatLng[]): LatLng[] {
  if (ring.length < 2) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (haversineMeters(first, last) < 1) return ring.slice(0, -1);
  return ring;
}

export type ScopeBounds = { minLat: number; maxLat: number; minLng: number; maxLng: number };

export function scopeBounds(scope: StreetScope): ScopeBounds {
  const bounds: ScopeBounds = {
    minLat: Number.POSITIVE_INFINITY,
    maxLat: Number.NEGATIVE_INFINITY,
    minLng: Number.POSITIVE_INFINITY,
    maxLng: Number.NEGATIVE_INFINITY,
  };

  for (const point of scope.ring) {
    if (point.lat < bounds.minLat) bounds.minLat = point.lat;
    if (point.lat > bounds.maxLat) bounds.maxLat = point.lat;
    if (point.lng < bounds.minLng) bounds.minLng = point.lng;
    if (point.lng > bounds.maxLng) bounds.maxLng = point.lng;
  }

  return bounds;
}

export function scopeCenter(scope: StreetScope): LatLng {
  if (scope.source.kind === "circle") return scope.source.center;
  const bounds = scopeBounds(scope);
  return { lat: (bounds.minLat + bounds.maxLat) / 2, lng: (bounds.minLng + bounds.maxLng) / 2 };
}

/** Rough planar area, good enough to tell a town from a kommun. */
export function scopeAreaKm2(scope: StreetScope): number {
  const ring = scope.ring;
  if (ring.length < 3) return 0;

  const centerLat = scopeCenter(scope).lat;
  const latScale = 111_320;
  const lngScale = 111_320 * Math.cos((centerLat * Math.PI) / 180);

  let twiceArea = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    twiceArea += (a.lng * lngScale) * (b.lat * latScale) - (b.lng * lngScale) * (a.lat * latScale);
  }

  return Math.abs(twiceArea / 2) / 1_000_000;
}

/**
 * Ray casting, in degrees. Over a town-sized ring the difference between this
 * and a projected test is far below the metre, and a street is either well
 * inside or straddling the edge — a case handled by clipping, not by a boolean.
 */
export function isInsideScope(point: LatLng, scope: StreetScope): boolean {
  const ring = scope.ring;
  if (ring.length < 3) return false;

  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    const straddles = a.lat > point.lat !== b.lat > point.lat;
    if (!straddles) continue;
    const crossingLng = a.lng + ((point.lat - a.lat) / (b.lat - a.lat)) * (b.lng - a.lng);
    if (point.lng < crossingLng) inside = !inside;
  }

  return inside;
}

/**
 * The parts of a line that fall inside the scope, split where it leaves.
 *
 * A street that straddles the edge of a project counts — but only the stretch
 * inside it does. Requiring the whole of such a street would let ground the
 * owner deliberately drew outside his area block the project for ever, and
 * dropping the street entirely would leave a hole in the town he lives in.
 *
 * Crossings are interpolated rather than snapped to the nearest sample, so the
 * denominator does not wobble with sampling density.
 */
export function clipToScope(points: LatLng[], scope: StreetScope): LatLng[][] {
  if (points.length < 2) {
    return points.length === 1 && isInsideScope(points[0], scope) ? [] : [];
  }

  const pieces: LatLng[][] = [];
  let current: LatLng[] = [];

  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1];
    const to = points[i];
    const cuts = crossingFractions(from, to, scope);

    let cursor = 0;
    const stops = [...cuts, 1];

    for (const stop of stops) {
      const subFrom = interpolate(from, to, cursor);
      const subTo = interpolate(from, to, stop);
      const midpoint = interpolate(from, to, (cursor + stop) / 2);

      if (isInsideScope(midpoint, scope)) {
        if (current.length === 0) current.push(subFrom);
        current.push(subTo);
      } else if (current.length >= 2) {
        pieces.push(current);
        current = [];
      } else {
        current = [];
      }

      cursor = stop;
    }
  }

  if (current.length >= 2) pieces.push(current);
  return pieces;
}

function interpolate(from: LatLng, to: LatLng, t: number): LatLng {
  return { lat: from.lat + (to.lat - from.lat) * t, lng: from.lng + (to.lng - from.lng) * t };
}

/** Where along `from`→`to` (0..1, ascending) the segment crosses the ring. */
function crossingFractions(from: LatLng, to: LatLng, scope: StreetScope): number[] {
  const ring = scope.ring;
  const fractions: number[] = [];

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const t = segmentIntersectionFraction(from, to, ring[j], ring[i]);
    if (t !== null && t > 1e-9 && t < 1 - 1e-9) fractions.push(t);
  }

  return fractions.sort((a, b) => a - b);
}

function segmentIntersectionFraction(p1: LatLng, p2: LatLng, q1: LatLng, q2: LatLng): number | null {
  const rx = p2.lng - p1.lng;
  const ry = p2.lat - p1.lat;
  const sx = q2.lng - q1.lng;
  const sy = q2.lat - q1.lat;

  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < 1e-15) return null;

  const t = ((q1.lng - p1.lng) * sy - (q1.lat - p1.lat) * sx) / denominator;
  const u = ((q1.lng - p1.lng) * ry - (q1.lat - p1.lat) * rx) / denominator;

  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return t;
}

/**
 * The ring as Overpass wants it: "lat lon lat lon ...".
 *
 * Overpass is a free shared service and a 4,000-point kommun boundary in a
 * `poly:` filter is a rude way to use it, so the ring is thinned first. The
 * tolerance is far finer than the street grid it selects.
 */
export function overpassPolyString(scope: StreetScope, maxPoints = 180): string {
  const ring = thinRing(scope.ring, maxPoints);
  return ring.map((point) => `${point.lat.toFixed(6)} ${point.lng.toFixed(6)}`).join(" ");
}

export function thinRing(ring: LatLng[], maxPoints: number): LatLng[] {
  if (ring.length <= maxPoints) return ring;
  const stride = Math.ceil(ring.length / maxPoints);
  const thinned = ring.filter((_, index) => index % stride === 0);
  return thinned.length >= 3 ? thinned : ring.slice(0, 3);
}

/** Largest distance from the centre to the ring — what a map has to fit. */
export function scopeRadiusMeters(scope: StreetScope): number {
  const center = scopeCenter(scope);
  let worst = 0;
  for (const point of scope.ring) {
    const distance = haversineMeters(center, point);
    if (distance > worst) worst = distance;
  }
  return worst;
}
