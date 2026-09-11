import { XMLParser } from "fast-xml-parser";
import { LatLng } from "../types";
import { haversineMeters } from "./utils/geo";

function ensureArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function createParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
  });
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const num = Number(value);
    if (value !== undefined && value !== null && value !== "" && Number.isFinite(num)) return num;
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

export function parseGpxToTrackPoints(gpxXml: string): LatLng[] {
  const parser = createParser();

  const parsed = parser.parse(gpxXml);
  const gpx = parsed?.gpx;
  const tracks = ensureArray(gpx?.trk);

  const points: LatLng[] = [];

  for (const track of tracks) {
    const segments = ensureArray(track?.trkseg);
    for (const segment of segments) {
      const trkpts = ensureArray(segment?.trkpt);
      for (const point of trkpts) {
        const lat = Number(point?.lat);
        const lng = Number(point?.lon);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          points.push({ lat, lng });
        }
      }
    }
  }

  return points;
}

// ---------------------------------------------------------------------------
// GPX export
// ---------------------------------------------------------------------------

export type GpxExportPoint = {
  lat: number;
  lng: number;
  elevation?: number;
  /** ISO 8601. Only real recorded times belong here. */
  time?: string;
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Serialises a route to GPX.
 *
 * A planned route is a course, not an activity: stamping every trackpoint with
 * "now" (which this app used to do) makes Garmin read a suggestion as a run that
 * was completed in zero seconds. Timestamps are therefore written only for
 * points that carry a real recorded time; a suggestion comes out as a plain
 * `<trk>` with no `<time>` elements, which Garmin imports as a course.
 */
export function buildRouteGpx(input: {
  name: string;
  points: GpxExportPoint[];
  createdAt?: string;
}): string {
  const name = escapeXml(input.name?.trim() || "Route");
  const createdAt = input.createdAt ?? new Date().toISOString();

  const trackpoints = input.points
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng))
    .map((point) => {
      const ele = Number.isFinite(point.elevation) ? `<ele>${Number(point.elevation).toFixed(1)}</ele>` : "";
      const time = point.time ? `<time>${escapeXml(point.time)}</time>` : "";
      return `      <trkpt lat="${point.lat.toFixed(6)}" lon="${point.lng.toFixed(6)}">${ele}${time}</trkpt>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GPX running" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${name}</name><time>${escapeXml(createdAt)}</time></metadata>
<trk><name>${name}</name><trkseg>
${trackpoints}
</trkseg></trk>
</gpx>`;
}

// ---------------------------------------------------------------------------
// Server-side track parsing for the ingestion spine.
//
// `src/lib/utils.ts` also parses GPX/TCX, but through `DOMParser`, which only
// exists in the browser. Ingestion runs in Node route handlers, so the
// fast-xml-parser path below is the single server-side parser: every adapter
// funnels its downloaded file through `parseTrackFile` rather than shipping its
// own parsing.
//
// GDPR data minimisation: these parsers read position, elevation and time only.
// Heart rate is present in most TCX files and is deliberately NOT extracted —
// it is Art. 9 special-category health data and the spine stays out of it.
// ---------------------------------------------------------------------------

export type TrackFileFormat = "gpx" | "tcx";

export type TrackPoint = {
  lat: number;
  lng: number;
  elevation?: number;
  /** ISO 8601 timestamp, when the file carries one. */
  time?: string;
};

export type TrackSummary = {
  points: TrackPoint[];
  /** [lon, lat] pairs in GeoJSON order, matching `GPXRoute.coordinates`. */
  coordinates: [number, number][];
  distanceMeters: number;
  elevationGainMeters: number;
  durationSeconds?: number;
  startedAt?: string;
  name?: string;
};

export function parseGpxTrackPoints(gpxXml: string): { points: TrackPoint[]; name?: string } {
  const parsed = createParser().parse(gpxXml);
  const gpx = parsed?.gpx;
  const tracks = ensureArray<any>(gpx?.trk);
  const points: TrackPoint[] = [];
  let name: string | undefined;

  for (const track of tracks) {
    name = name ?? firstString(track?.name);
    for (const segment of ensureArray<any>(track?.trkseg)) {
      for (const point of ensureArray<any>(segment?.trkpt)) {
        const lat = Number(point?.lat);
        const lng = Number(point?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        points.push({
          lat,
          lng,
          elevation: firstNumber(point?.ele),
          time: firstString(point?.time),
        });
      }
    }
  }

  return { points, name: name ?? firstString(gpx?.metadata?.name) };
}

export function parseTcxTrackPoints(tcxXml: string): { points: TrackPoint[]; name?: string } {
  const parsed = createParser().parse(tcxXml);
  const root = parsed?.TrainingCenterDatabase;
  const points: TrackPoint[] = [];
  let name: string | undefined;

  for (const activity of ensureArray<any>(root?.Activities?.Activity)) {
    name = name ?? firstString(activity?.Notes);
    for (const lap of ensureArray<any>(activity?.Lap)) {
      for (const track of ensureArray<any>(lap?.Track)) {
        for (const point of ensureArray<any>(track?.Trackpoint)) {
          const lat = firstNumber(point?.Position?.LatitudeDegrees);
          const lng = firstNumber(point?.Position?.LongitudeDegrees);
          if (lat === undefined || lng === undefined) continue;
          points.push({
            lat,
            lng,
            elevation: firstNumber(point?.AltitudeMeters),
            time: firstString(point?.Time),
            // point.HeartRateBpm is intentionally ignored (Art. 9).
          });
        }
      }
    }
  }

  return { points, name };
}

export function detectTrackFormat(content: string): TrackFileFormat | null {
  const head = content.slice(0, 2000);
  if (/<TrainingCenterDatabase/i.test(head)) return "tcx";
  if (/<gpx[\s>]/i.test(head)) return "gpx";
  return null;
}

/**
 * The single entry point adapters use. Give it a downloaded file, get back
 * geometry plus the summary figures the canonical activity needs.
 */
export function parseTrackFile(content: string, format?: TrackFileFormat): TrackSummary {
  const resolved = format ?? detectTrackFormat(content);
  if (!resolved) throw new Error("Unrecognised track file: expected GPX or TCX");

  const { points, name } = resolved === "tcx" ? parseTcxTrackPoints(content) : parseGpxTrackPoints(content);
  return summariseTrack(points, name);
}

export function summariseTrack(points: TrackPoint[], name?: string): TrackSummary {
  let distanceMeters = 0;
  let elevationGainMeters = 0;
  let lastElevation: number | undefined;

  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (i > 0) {
      distanceMeters += haversineMeters(points[i - 1] as LatLng, point as LatLng);
    }
    if (point.elevation !== undefined) {
      // Ignore sub-metre jitter so GPS noise does not inflate the climb.
      if (lastElevation !== undefined && point.elevation - lastElevation > 1) {
        elevationGainMeters += point.elevation - lastElevation;
      }
      if (lastElevation === undefined || Math.abs(point.elevation - lastElevation) > 1) {
        lastElevation = point.elevation;
      }
    }
  }

  const times = points.map((point) => point.time).filter((time): time is string => Boolean(time));
  const firstTime = times.length ? new Date(times[0]) : null;
  const lastTime = times.length ? new Date(times[times.length - 1]) : null;
  const durationSeconds =
    firstTime && lastTime && !Number.isNaN(firstTime.valueOf()) && !Number.isNaN(lastTime.valueOf())
      ? Math.max(0, Math.round((lastTime.valueOf() - firstTime.valueOf()) / 1000))
      : undefined;

  return {
    points,
    coordinates: points.map((point) => [point.lng, point.lat] as [number, number]),
    distanceMeters: Math.round(distanceMeters),
    elevationGainMeters: Math.round(elevationGainMeters),
    durationSeconds,
    startedAt: firstTime && !Number.isNaN(firstTime.valueOf()) ? firstTime.toISOString() : undefined,
    name,
  };
}
