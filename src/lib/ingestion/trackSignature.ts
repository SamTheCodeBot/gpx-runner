import { haversineMeters } from "@/engine/utils/geo";

/**
 * The shared identity of a run: how we sample a track, and how we decide that
 * two records describe the same outing.
 *
 * This module exists so there is exactly ONE such algorithm. `fingerprint.ts`
 * adds a SHA-256 over the material produced here to get the exact-match fast
 * path used inside the ingestion spine; the client-side read layer uses the
 * same sampling and the same tolerances without hashing, because a browser has
 * no synchronous SHA-256 and, more importantly, because a second algorithm
 * would drift away from the first.
 *
 * Deliberately free of node builtins and of Firestore: it is imported by both
 * server ingestion and client components.
 *
 * The hard problem it solves: two recordings of one run disagree. A watch file
 * synced to intervals.icu and the same run exported to GPX and uploaded by hand
 * differ in point count, in start time (the watch's clock versus the provider's
 * record of it), in distance (smoothing), and in the exact first fix. So the
 * track is sampled BY DISTANCE ALONG THE ROUTE rather than by array index \u2014 the
 * point 40% of the way round is the same place whether the file holds 900
 * points or 4,000 \u2014 and every scalar is compared with a tolerance rather than
 * for equality.
 */

/** ~110 m grid. Coarse on purpose: it must survive provider-to-provider jitter. */
export const COORD_DECIMALS = 3;
export const SAMPLE_POINTS = 16;
export const START_BUCKET_SECONDS = 120;
export const DISTANCE_BUCKET_METERS = 50;

/** Two recordings of one run never start more than this far apart. */
export const DUPLICATE_START_WINDOW_MS = 10 * 60 * 1000;
/** Providers disagree on distance by smoothing artefacts, not by much. */
export const DUPLICATE_DISTANCE_TOLERANCE = 0.03;
export const DUPLICATE_DISTANCE_FLOOR_M = 200;
/** Moving time versus elapsed time is the usual disagreement here. */
export const DUPLICATE_DURATION_TOLERANCE = 0.1;
export const DUPLICATE_DURATION_FLOOR_S = 120;
/** GPS fixes at the same start line, from two devices or two exports. */
export const DUPLICATE_START_POINT_M = 500;
/** How far apart two sampled points may be and still be "the same place". */
export const SAMPLE_MATCH_M = 150;
/** Fraction of sampled points that must line up before geometry agrees. */
export const GEOMETRY_MATCH_RATIO = 0.7;

export type FingerprintInput = {
  startedAt: string;
  distanceMeters: number;
  /** [lon, lat] pairs, GeoJSON order. */
  coordinates: [number, number][];
};

function format(lon: number, lat: number): string {
  return `${lon.toFixed(COORD_DECIMALS)},${lat.toFixed(COORD_DECIMALS)}`;
}

/**
 * Sample evenly along the track's length, interpolating between the points
 * either side of each target distance.
 */
export function sampleAlongDistance(coordinates: [number, number][]): [number, number][] {
  if (coordinates.length === 0) return [];
  if (coordinates.length === 1) return [coordinates[0]];

  const cumulative: number[] = [0];
  for (let i = 1; i < coordinates.length; i += 1) {
    const [prevLon, prevLat] = coordinates[i - 1];
    const [lon, lat] = coordinates[i];
    cumulative.push(
      cumulative[i - 1] + haversineMeters({ lat: prevLat, lng: prevLon }, { lat, lng: lon }),
    );
  }

  const total = cumulative[cumulative.length - 1];
  if (total <= 0) return [coordinates[0]];

  const samples: [number, number][] = [];
  let cursor = 1;

  for (let i = 0; i < SAMPLE_POINTS; i += 1) {
    const target = (total * i) / (SAMPLE_POINTS - 1);
    while (cursor < cumulative.length - 1 && cumulative[cursor] < target) cursor += 1;

    const spanStart = cumulative[cursor - 1];
    const spanEnd = cumulative[cursor];
    const span = spanEnd - spanStart;
    const ratio = span > 0 ? (target - spanStart) / span : 0;

    const [startLon, startLat] = coordinates[cursor - 1];
    const [endLon, endLat] = coordinates[cursor];

    samples.push([
      startLon + (endLon - startLon) * ratio,
      startLat + (endLat - startLat) * ratio,
    ]);
  }

  return samples;
}

/**
 * The exact material the fingerprint hashes: bucketed start time, bucketed
 * distance, and the sampled geometry on a coarse grid.
 */
export function signatureMaterial(input: FingerprintInput): string {
  const startMs = new Date(input.startedAt).valueOf();
  const startBucket = Number.isFinite(startMs)
    ? Math.round(startMs / 1000 / START_BUCKET_SECONDS)
    : 0;
  const distanceBucket = Math.round((input.distanceMeters || 0) / DISTANCE_BUCKET_METERS);
  const geometry = sampleAlongDistance(input.coordinates)
    .map(([lon, lat]) => format(lon, lat))
    .join("|");

  return [`t=${startBucket}`, `d=${distanceBucket}`, `g=${geometry}`].join(";");
}

/**
 * What we need to know about a record to ask "is this the same run?".
 *
 * Every field beyond `startedAt` and `distanceMeters` is optional, because the
 * two sides of a cross-collection comparison genuinely hold different things: a
 * spine-ingested activity has a fingerprint, a manually uploaded route has full
 * geometry and no fingerprint at all.
 */
export type RunIdentity = {
  startedAt: string;
  distanceMeters: number;
  durationSeconds?: number;
  /** Present only on records the ingestion spine wrote. */
  fingerprint?: string;
  /** First track point, [lon, lat]. */
  startPoint?: [number, number];
  /** Output of `sampleAlongDistance`, when the caller holds the geometry. */
  sampledTrack?: [number, number][];
};

function withinTolerance(a: number, b: number, ratio: number, floor: number): boolean {
  return Math.abs(a - b) <= Math.max(floor, Math.max(Math.abs(a), Math.abs(b)) * ratio);
}

/**
 * Fraction of sampled points that land within `SAMPLE_MATCH_M` of each other.
 *
 * Compared as coordinates rather than as grid strings on purpose: a string
 * comparison on a rounded grid has cell boundaries, so two fixes 10 m apart can
 * disagree simply because they straddle one. Distance has no such behaviour.
 */
export function trackOverlapRatio(a: [number, number][], b: [number, number][]): number {
  if (!a.length || !b.length) return 0;

  const pairs = Math.min(a.length, b.length);
  let matched = 0;

  for (let i = 0; i < pairs; i += 1) {
    const apart = haversineMeters(
      { lat: a[i][1], lng: a[i][0] },
      { lat: b[i][1], lng: b[i][0] },
    );
    if (apart <= SAMPLE_MATCH_M) matched += 1;
  }

  return matched / pairs;
}

/**
 * Is this the same run, recorded twice?
 *
 * Two stages, in this order:
 *
 *   1. Equal fingerprints \u2014 the exact-match fast path, when both sides have one.
 *   2. Tolerance comparison of start time, distance, duration and start point,
 *      which has no bucket boundaries and so cannot miss the way a hash can.
 *      Where both sides carry sampled geometry, the shapes must also agree;
 *      that is what stops two different 10 km runs started at the same minute
 *      from collapsing into one.
 *
 * A person cannot run two different runs at the same time, so this is decisive
 * without being brittle.
 */
export function isSameRun(a: RunIdentity, b: RunIdentity): boolean {
  if (a.fingerprint && b.fingerprint && a.fingerprint === b.fingerprint) return true;

  const startA = new Date(a.startedAt).valueOf();
  const startB = new Date(b.startedAt).valueOf();
  if (!Number.isFinite(startA) || !Number.isFinite(startB)) return false;
  if (Math.abs(startA - startB) > DUPLICATE_START_WINDOW_MS) return false;

  if (
    !withinTolerance(
      a.distanceMeters,
      b.distanceMeters,
      DUPLICATE_DISTANCE_TOLERANCE,
      DUPLICATE_DISTANCE_FLOOR_M,
    )
  ) {
    return false;
  }

  if (a.durationSeconds && b.durationSeconds) {
    if (
      !withinTolerance(
        a.durationSeconds,
        b.durationSeconds,
        DUPLICATE_DURATION_TOLERANCE,
        DUPLICATE_DURATION_FLOOR_S,
      )
    ) {
      return false;
    }
  }

  if (a.startPoint && b.startPoint) {
    const apart = haversineMeters(
      { lat: a.startPoint[1], lng: a.startPoint[0] },
      { lat: b.startPoint[1], lng: b.startPoint[0] },
    );
    if (apart > DUPLICATE_START_POINT_M) return false;
  }

  if (a.sampledTrack?.length && b.sampledTrack?.length) {
    return trackOverlapRatio(a.sampledTrack, b.sampledTrack) >= GEOMETRY_MATCH_RATIO;
  }

  return true;
}
