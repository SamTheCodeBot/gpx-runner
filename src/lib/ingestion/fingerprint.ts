import { createHash } from "crypto";

/**
 * Content fingerprint for cross-adapter dedupe.
 *
 * `(source, sourceActivityId)` catches the same provider delivering the same
 * activity twice (webhook plus reconciliation pull). It cannot catch the same
 * run arriving from two different providers \u2014 the Garmin watch file synced to
 * intervals.icu and the same run pushed to Strava are one run with two ids.
 * The fingerprint closes that gap.
 *
 * It is built from things that do not change between providers: rounded start
 * time, rounded distance, and a coarse sample of the track. Coordinates are
 * rounded to ~11 m and only a fixed number of points are sampled, so small
 * differences in smoothing or point density between providers still collapse to
 * the same value.
 */

const COORD_DECIMALS = 4; // ~11 m at the equator
const SAMPLE_POINTS = 24;
const START_BUCKET_SECONDS = 120;
const DISTANCE_BUCKET_METERS = 50;

export type FingerprintInput = {
  startedAt: string;
  distanceMeters: number;
  /** [lon, lat] pairs, GeoJSON order. */
  coordinates: [number, number][];
};

function sampleCoordinates(coordinates: [number, number][]): string[] {
  if (!coordinates.length) return [];
  if (coordinates.length <= SAMPLE_POINTS) {
    return coordinates.map(([lon, lat]) => `${lon.toFixed(COORD_DECIMALS)},${lat.toFixed(COORD_DECIMALS)}`);
  }

  const step = (coordinates.length - 1) / (SAMPLE_POINTS - 1);
  const sampled: string[] = [];
  for (let i = 0; i < SAMPLE_POINTS; i += 1) {
    const [lon, lat] = coordinates[Math.round(i * step)];
    sampled.push(`${lon.toFixed(COORD_DECIMALS)},${lat.toFixed(COORD_DECIMALS)}`);
  }
  return sampled;
}

export function fingerprintTrack(input: FingerprintInput): string {
  const startMs = new Date(input.startedAt).valueOf();
  const startBucket = Number.isFinite(startMs)
    ? Math.round(startMs / 1000 / START_BUCKET_SECONDS)
    : 0;
  const distanceBucket = Math.round((input.distanceMeters || 0) / DISTANCE_BUCKET_METERS);

  const material = [
    `t=${startBucket}`,
    `d=${distanceBucket}`,
    `g=${sampleCoordinates(input.coordinates).join("|")}`,
  ].join(";");

  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}
