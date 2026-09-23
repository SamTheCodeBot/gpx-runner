import { LatLng } from "../types";
import { haversineMeters, simplifyByDistance } from "./utils/geo";

/**
 * Bounding the runner's history before it is measured against a candidate loop.
 *
 * An ultra runner can have thousands of logged kilometres. Posting every
 * coordinate of every activity to the suggestion endpoint would be slow and
 * pointless: only the ground within reach of the start point can overlap a loop
 * that starts there, and familiarity is a ~10 m question, so ~20 m sampling is
 * plenty. Shared by the client (trim before POST) and the server (guard rail).
 */

export type TrackBounds = {
  radiusMeters: number;
  simplifyMeters?: number;
  maxTracks?: number;
  maxPointsPerTrack?: number;
  maxTotalPoints?: number;
};

export const DEFAULT_SIMPLIFY_METERS = 20;

/**
 * How far from the start logged ground can still be part of the loop. A loop of
 * D km never reaches further than D/2 km from its start, so D km of slack is
 * generous without being unbounded.
 */
export function historyRadiusMeters(targetDistanceKm: number, minKm = 2, maxKm = 30): number {
  const km = Math.min(maxKm, Math.max(minKm, targetDistanceKm));
  return km * 1000;
}

/**
 * Pick the runs near a start point, cheaply, before anything is allocated.
 *
 * The caller used to do `routes.map(toLatLngTrack)` and hand the lot to
 * `boundTracksNearStart`, which keeps the first 150 and throws the rest away.
 * So an entire history — one `{lat, lng}` object per GPS point, hundreds of
 * thousands of them — was built in order to discard most of it, synchronously,
 * inside a click handler. That is what a 5.6 s blocked interaction is made of.
 *
 * This walks the raw `[lng, lat]` arrays instead: no objects, no trigonometry,
 * just a planar distance in a local projection, which over a few tens of
 * kilometres is far more accuracy than "is this run anywhere near here" needs.
 * Only the runs that survive are converted.
 *
 * It also fixes a quieter bug. Taking the *first* 150 tracks meant an
 * arbitrary slice of the history in array order; a runner with 500 logged runs
 * got his familiarity measured against whichever ones happened to load first.
 * Nearest-first is both cheaper and correct.
 */
export function selectTracksNearStart(
  routes: Array<{ coordinates: unknown }>,
  start: LatLng,
  radiusMeters: number,
  maxTracks: number,
): LatLng[][] {
  const metersPerDegreeLng = 111_320 * Math.cos((start.lat * Math.PI) / 180);
  const radiusSquared = radiusMeters * radiusMeters;

  const near: Array<{ coordinates: [number, number][]; distanceSquared: number }> = [];

  for (const route of routes) {
    const coordinates = route?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) continue;

    let best = Number.POSITIVE_INFINITY;
    for (const point of coordinates) {
      if (!Array.isArray(point) || point.length !== 2) continue;
      const dx = ((point[0] as number) - start.lng) * metersPerDegreeLng;
      const dy = ((point[1] as number) - start.lat) * 111_320;
      const squared = dx * dx + dy * dy;
      if (squared < best) {
        best = squared;
        // Already inside the radius: no closer answer would change the verdict.
        if (best <= radiusSquared) break;
      }
    }

    if (best <= radiusSquared) {
      near.push({ coordinates: coordinates as [number, number][], distanceSquared: best });
    }
  }

  near.sort((a, b) => a.distanceSquared - b.distanceSquared);

  return near.slice(0, maxTracks).map((entry) => toLatLngTrack(entry.coordinates));
}

/**
 * The centre of a history, without building an array of every point in it.
 *
 * `routes.flatMap(r => r.coordinates)` to take a mean allocates a copy of the
 * whole history for two running totals. On the click path that is pure cost.
 */
export function historyCenter(routes: Array<{ coordinates: unknown }>): LatLng | null {
  let latTotal = 0;
  let lngTotal = 0;
  let count = 0;

  for (const route of routes) {
    const coordinates = route?.coordinates;
    if (!Array.isArray(coordinates)) continue;
    for (const point of coordinates) {
      if (!Array.isArray(point) || point.length !== 2) continue;
      const lng = point[0] as number;
      const lat = point[1] as number;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      latTotal += lat;
      lngTotal += lng;
      count += 1;
    }
  }

  return count === 0 ? null : { lat: latTotal / count, lng: lngTotal / count };
}

export function toLatLngTrack(coordinates: unknown): LatLng[] {
  if (!Array.isArray(coordinates)) return [];
  return coordinates
    .filter(
      (point): point is [number, number] =>
        Array.isArray(point) && point.length === 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]),
    )
    .map(([lng, lat]) => ({ lat, lng }));
}

export function boundTracksNearStart(tracks: LatLng[][], start: LatLng, bounds: TrackBounds): LatLng[][] {
  const simplifyMeters = bounds.simplifyMeters ?? DEFAULT_SIMPLIFY_METERS;
  const maxTracks = bounds.maxTracks ?? 150;
  const maxPointsPerTrack = bounds.maxPointsPerTrack ?? 600;
  const maxTotalPoints = bounds.maxTotalPoints ?? 30_000;

  const bounded: LatLng[][] = [];
  let totalPoints = 0;

  for (const track of tracks.slice(0, maxTracks)) {
    if (!Array.isArray(track) || track.length < 2) continue;

    for (const stretch of splitInsideRadius(track, start, bounds.radiusMeters)) {
      const thinned = thin(stretch, maxPointsPerTrack, simplifyMeters);
      if (thinned.length < 2) continue;

      bounded.push(thinned);
      totalPoints += thinned.length;
      if (totalPoints >= maxTotalPoints) return bounded;
    }
  }

  return bounded;
}

/**
 * A run that leaves the area and comes back must not be stitched into a straight
 * line across the gap — that would invent ground the runner never covered.
 */
export function splitInsideRadius(points: LatLng[], start: LatLng, radiusMeters: number): LatLng[][] {
  const stretches: LatLng[][] = [];
  let current: LatLng[] = [];

  for (const point of points) {
    if (Number.isFinite(point?.lat) && Number.isFinite(point?.lng) && haversineMeters(start, point) <= radiusMeters) {
      current.push(point);
      continue;
    }
    if (current.length >= 2) stretches.push(current);
    current = [];
  }

  if (current.length >= 2) stretches.push(current);
  return stretches;
}

/** Thins a track to at most `maxPoints` by sampling coarser, never by truncating. */
export function thin(points: LatLng[], maxPoints: number, simplifyMeters = DEFAULT_SIMPLIFY_METERS): LatLng[] {
  let step = simplifyMeters;
  let simplified = simplifyByDistance(points, step);

  while (simplified.length > maxPoints && step < 400) {
    step *= 2;
    simplified = simplifyByDistance(points, step);
  }

  if (simplified.length <= maxPoints) return simplified;
  const stride = Math.ceil(simplified.length / maxPoints);
  return simplified.filter((_, index) => index % stride === 0 || index === simplified.length - 1);
}
