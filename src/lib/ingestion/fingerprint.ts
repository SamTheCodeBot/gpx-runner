import { createHash } from "crypto";
import { haversineMeters } from "@/engine/utils/geo";

/**
 * Content fingerprint for cross-adapter dedupe.
 *
 * `(source, sourceActivityId)` catches the same provider delivering the same
 * activity twice (a webhook and the reconciliation pull racing each other). It
 * cannot catch the same run arriving from two different providers \u2014 the watch
 * file synced to intervals.icu and the same run pushed to Strava are one run
 * with two ids. The fingerprint closes that gap.
 *
 * The hard part is that two providers describe the same run differently: one
 * may return 4,000 points and another 900 after smoothing. So the track is
 * sampled **by distance along the route**, not by array index \u2014 the point at
 * 10% of the way round is the same place regardless of how many samples the
 * file contains. Start time and distance are bucketed for the same reason.
 *
 * Role: this hash is the *exact-match fast path*. Because any rounding scheme
 * has boundaries, two descriptions of one run can still land either side of a
 * bucket edge and hash differently — so the hash is not trusted as the only
 * check. `findDuplicate` in `store.ts` follows it with a tolerance-based
 * comparison of start time, distance and start point, which has no boundary
 * behaviour. The exact guarantee for same-provider redelivery remains
 * `(source, sourceActivityId)`, enforced by the Firestore document id.
 */

/** ~110 m grid. Coarse on purpose: it must survive provider-to-provider jitter. */
const COORD_DECIMALS = 3;
const SAMPLE_POINTS = 16;
const START_BUCKET_SECONDS = 120;
const DISTANCE_BUCKET_METERS = 50;

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
function sampleAlongDistance(coordinates: [number, number][]): string[] {
  if (coordinates.length === 0) return [];
  if (coordinates.length === 1) return [format(coordinates[0][0], coordinates[0][1])];

  const cumulative: number[] = [0];
  for (let i = 1; i < coordinates.length; i += 1) {
    const [prevLon, prevLat] = coordinates[i - 1];
    const [lon, lat] = coordinates[i];
    cumulative.push(
      cumulative[i - 1] + haversineMeters({ lat: prevLat, lng: prevLon }, { lat, lng: lon }),
    );
  }

  const total = cumulative[cumulative.length - 1];
  if (total <= 0) return [format(coordinates[0][0], coordinates[0][1])];

  const samples: string[] = [];
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

    samples.push(
      format(startLon + (endLon - startLon) * ratio, startLat + (endLat - startLat) * ratio),
    );
  }

  return samples;
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
    `g=${sampleAlongDistance(input.coordinates).join("|")}`,
  ].join(";");

  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}
