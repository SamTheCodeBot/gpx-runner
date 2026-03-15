import { LatLng } from "../types";
import { haversineMeters, normalizeLoop, polylineDistanceMeters, simplifyByDistance } from "./utils/geo";

function cumulativeDistances(points: LatLng[]): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i += 1) {
    out.push(out[out.length - 1] + haversineMeters(points[i - 1], points[i]));
  }
  return out;
}

function sliceDistance(cumulative: number[], startIdx: number, endIdx: number): number {
  return cumulative[endIdx] - cumulative[startIdx];
}

function nearestPointDistance(points: LatLng[], start: LatLng): number {
  let best = Number.POSITIVE_INFINITY;
  for (const point of points) {
    const d = haversineMeters(point, start);
    if (d < best) best = d;
  }
  return best;
}

function rotateToNearestStart(points: LatLng[], start: LatLng): LatLng[] {
  if (points.length < 2) return points;

  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < points.length; i += 1) {
    const d = haversineMeters(points[i], start);
    if (d < bestDistance) {
      bestDistance = d;
      bestIndex = i;
    }
  }

  if (bestIndex === 0) return points;
  const rotated = [...points.slice(bestIndex), ...points.slice(1, bestIndex + 1)];
  return normalizeLoop(rotated);
}

function dedupeCandidates(candidates: LatLng[][]): LatLng[][] {
  const seen = new Set<string>();
  const out: LatLng[][] = [];

  for (const candidate of candidates) {
    const key = candidate
      .filter((_, index) => index % Math.max(1, Math.floor(candidate.length / 24)) === 0)
      .map((point) => `${point.lat.toFixed(4)}:${point.lng.toFixed(4)}`)
      .join("|");

    if (!seen.has(key)) {
      seen.add(key);
      out.push(candidate);
    }
  }

  return out;
}

export function findHistoricalLoopCandidates(params: {
  tracks: LatLng[][];
  start: LatLng;
  targetMeters: number;
  toleranceMeters: number;
  maxResults?: number;
}): LatLng[][] {
  const maxResults = params.maxResults ?? 12;
  const nearStartMeters = 90;
  const searchTolerance = params.toleranceMeters * 1.15;
  const minLoopMeters = Math.max(800, params.targetMeters * 0.5);
  const candidates: { geometry: LatLng[]; distanceMeters: number; startProximity: number }[] = [];

  for (const rawTrack of params.tracks) {
    const track = simplifyByDistance(rawTrack, 10);
    if (track.length < 12) continue;

    const wholeTrackDistance = polylineDistanceMeters(track);
    const trackStartGap = haversineMeters(track[0], params.start);
    const trackEndGap = haversineMeters(track[track.length - 1], params.start);
    if (
      trackStartGap <= nearStartMeters &&
      trackEndGap <= nearStartMeters &&
      Math.abs(wholeTrackDistance - params.targetMeters) <= searchTolerance
    ) {
      candidates.push({
        geometry: rotateToNearestStart(normalizeLoop(track), params.start),
        distanceMeters: wholeTrackDistance,
        startProximity: Math.min(trackStartGap, trackEndGap),
      });
    }

    const cumulative = cumulativeDistances(track);
    const nearIndices: number[] = [];
    for (let i = 0; i < track.length; i += 1) {
      if (haversineMeters(track[i], params.start) <= nearStartMeters) nearIndices.push(i);
    }

    for (let a = 0; a < nearIndices.length; a += 1) {
      const startIdx = nearIndices[a];
      for (let b = a + 1; b < nearIndices.length; b += 1) {
        const endIdx = nearIndices[b];
        const segmentDistance = sliceDistance(cumulative, startIdx, endIdx);
        if (segmentDistance < minLoopMeters) continue;
        if (segmentDistance > params.targetMeters + searchTolerance) break;

        if (Math.abs(segmentDistance - params.targetMeters) > searchTolerance) continue;

        const segment = normalizeLoop(track.slice(startIdx, endIdx + 1));
        const startProximity = nearestPointDistance([segment[0], segment[segment.length - 1]], params.start);
        candidates.push({ geometry: rotateToNearestStart(segment, params.start), distanceMeters: segmentDistance, startProximity });
      }
    }
  }

  return dedupeCandidates(
    candidates
      .sort((a, b) => {
        const aScore = Math.abs(a.distanceMeters - params.targetMeters) + a.startProximity * 8;
        const bScore = Math.abs(b.distanceMeters - params.targetMeters) + b.startProximity * 8;
        return aScore - bScore;
      })
      .slice(0, maxResults * 3)
      .map((entry) => entry.geometry),
  ).slice(0, maxResults);
}
