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
