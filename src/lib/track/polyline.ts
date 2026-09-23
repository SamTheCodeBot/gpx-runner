/**
 * Encoded polyline storage for run geometry.
 *
 * WHY THIS EXISTS
 *
 * A track used to be stored as an array of `{ lat, lon }` maps. Firestore
 * indexes every element of an array of maps, so a 4,000-point run wrote 4,000
 * index entries, and a fourteen-year history wrote millions of them. The index
 * cost more storage than the documents it pointed at, and every write had to
 * update all of it — which is the part the user feels as a slow import.
 *
 * The same geometry as a Google-encoded polyline is one string field: roughly
 * 5-8 bytes per point against ~30 plus an index entry, and a string is indexed
 * once whatever its length. A 4,000-point run goes from ~120 kB to ~28 kB.
 *
 * PRECISION
 *
 * Precision 5 is ~1.1 m at the equator and better at Swedish latitudes. Nothing
 * downstream reads finer: the familiarity index simplifies to 18 m, street
 * coverage to 30 m, the map draws 500 points. Storing metres of precision that
 * no consumer can see was never buying anything.
 *
 * ORDER
 *
 * The app's internal geometry is `[lon, lat]`, GeoJSON order, and these
 * functions take and return that. The encoding itself is latitude-first, which
 * is where this kind of code usually goes wrong, so the swap happens here once
 * rather than at every call site.
 */

const PRECISION = 5;
const FACTOR = 10 ** PRECISION;

function encodeSignedValue(value: number, output: string[]): void {
  let coordinate = value < 0 ? ~(value << 1) : value << 1;
  while (coordinate >= 0x20) {
    output.push(String.fromCharCode((0x20 | (coordinate & 0x1f)) + 63));
    coordinate >>= 5;
  }
  output.push(String.fromCharCode(coordinate + 63));
}

/** `[lon, lat]` pairs to an encoded polyline. */
export function encodePolyline(coordinates: ReadonlyArray<readonly [number, number]>): string {
  const output: string[] = [];
  let previousLat = 0;
  let previousLon = 0;

  for (const [lon, lat] of coordinates) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const scaledLat = Math.round(lat * FACTOR);
    const scaledLon = Math.round(lon * FACTOR);
    encodeSignedValue(scaledLat - previousLat, output);
    encodeSignedValue(scaledLon - previousLon, output);
    previousLat = scaledLat;
    previousLon = scaledLon;
  }

  return output.join("");
}

/** An encoded polyline back to `[lon, lat]` pairs. */
export function decodePolyline(encoded: string): [number, number][] {
  if (!encoded) return [];

  const coordinates: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    lon += result & 1 ? ~(result >> 1) : result >> 1;

    coordinates.push([lon / FACTOR, lat / FACTOR]);
  }

  return coordinates;
}

/** What a stored track looks like on a route document. */
export type StoredTrack = {
  encoding: "polyline5";
  points: string;
  count: number;
};

export function toStoredTrack(
  coordinates: ReadonlyArray<readonly [number, number]>,
): StoredTrack {
  return {
    encoding: "polyline5",
    points: encodePolyline(coordinates),
    count: coordinates.length,
  };
}

/**
 * Read geometry off a route document in either shape.
 *
 * Documents written before this change hold `coordinates` as an array of
 * `{ lat, lon }` maps, and there is no migration: a route written in 2024 is
 * read exactly as it was written, for as long as it exists. New writes carry
 * `track`. Both are read here so no call site has to know which era a document
 * came from.
 */
export function readTrackCoordinates(data: unknown): [number, number][] {
  if (!data || typeof data !== "object") return [];
  const record = data as Record<string, unknown>;

  const track = record.track as Partial<StoredTrack> | undefined;
  if (track && typeof track.points === "string" && track.encoding === "polyline5") {
    return decodePolyline(track.points);
  }

  const legacy = record.coordinates;
  if (Array.isArray(legacy)) {
    return legacy
      .map((point) => {
        if (Array.isArray(point) && point.length >= 2) {
          return [Number(point[0]), Number(point[1])] as [number, number];
        }
        if (point && typeof point === "object") {
          const { lat, lon } = point as { lat?: unknown; lon?: unknown };
          if (typeof lat === "number" && typeof lon === "number") {
            return [lon, lat] as [number, number];
          }
        }
        return null;
      })
      .filter((point): point is [number, number] => point !== null);
  }

  return [];
}

/** How many points a document holds, without decoding the whole track. */
export function storedTrackLength(data: unknown): number {
  if (!data || typeof data !== "object") return 0;
  const record = data as Record<string, unknown>;
  const track = record.track as Partial<StoredTrack> | undefined;
  if (track && typeof track.count === "number") return track.count;
  return Array.isArray(record.coordinates) ? record.coordinates.length : 0;
}
