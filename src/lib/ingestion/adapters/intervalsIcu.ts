import { parseTrackFile } from "@/engine/gpx";
import {
  disconnectIntervalsApp,
  downloadIntervalsGpx,
  exchangeIntervalsCode,
  getIntervalsAthlete,
  IntervalsApiError,
  listIntervalsActivities,
  type IntervalsActivity,
  type IntervalsAuth,
} from "@/lib/intervals";
import type {
  ActivityCursor,
  ActivityListPage,
  ActivitySource,
  ActivitySourceConnectInput,
  CanonicalSport,
  ConnectResult,
  NormalizeInput,
  NormalizedActivity,
  RouteMetricSample,
  SourceActivityFile,
  SourceActivitySummary,
  SourceCredentials,
} from "@/app/types";
import { looksIndoor, MIN_INGESTED_DISTANCE_METERS } from "../sportPolicy";

/**
 * intervals.icu adapter \u2014 the first implementation of `ActivitySource`.
 *
 * It is deliberately the first one because it must be replaceable. Everything
 * provider-specific stops at this file: the rest of the spine only ever sees
 * `SourceActivitySummary` and `NormalizedActivity`. Deleting this file and its
 * four routes would remove intervals.icu from the product without touching the
 * canonical model, dedupe, retention, consent, export or erasure.
 */

const MAX_LIST_LIMIT = 200;

function toAuth(credentials: SourceCredentials): IntervalsAuth {
  return { accessToken: credentials.accessToken, apiKey: credentials.apiKey };
}

/**
 * Map intervals.icu activity types onto our canonical sports. The source values
 * are the documented `SportInfo.type` enum from the OpenAPI spec.
 *
 * Mapping is only translation — whether a sport is *ingested* is decided in one
 * place, `sportPolicy.ts`. `VirtualRun` is mapped to `other` here and rejected
 * there; `Walk`/`Hike` still translate cleanly so that re-enabling them later
 * is a change to the policy list alone.
 */
function toCanonicalSport(type: string | undefined): CanonicalSport {
  switch (type) {
    case "Run":
      return "run";
    case "TrailRun":
      return "trail_run";
    case "Walk":
      return "walk";
    case "Hike":
      return "hike";
    // VirtualRun and everything else — including the indoor machines in the
    // enum (Elliptical, StairStepper, Workout) — are not foot-outdoor sports.
    default:
      return "other";
  }
}

/**
 * Did this happen indoors?
 *
 * `trainer` is the verified indicator on the `Activity` schema and the one that
 * actually catches the case that matters: a Garmin treadmill run syncs as
 * `type: "Run"`, not `VirtualRun`, so the sport label alone says nothing.
 * `indoor` is read defensively — it is not a documented Activity property and
 * is not requested, so it will normally be undefined (see `intervals.ts`).
 */
function isIndoor(activity: IntervalsActivity): boolean {
  if (activity.trainer === true) return true;
  if (activity.indoor === true) return true;
  // Belt and braces: the sport label and upload source, judged by the shared
  // policy so there is one definition of "indoor" in the codebase.
  return looksIndoor({
    sport: toCanonicalSport(activity.type),
    sourceSport: activity.type,
    uploadSource: activity.source,
  });
}

/**
 * `start_date_local` is a local wall-clock time without an offset, so it is
 * combined with the activity's reported IANA zone to get a true instant. When
 * the zone is missing we fall back to treating the value as UTC, which is the
 * same assumption the existing Strava sync makes.
 */
function toInstant(activity: IntervalsActivity): string {
  const raw = activity.start_date ?? activity.start_date_local;
  if (!raw) return new Date().toISOString();

  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw);
  const parsed = new Date(hasOffset ? raw : `${raw}Z`);
  return Number.isNaN(parsed.valueOf()) ? new Date().toISOString() : parsed.toISOString();
}

/**
 * Whether the activity is worth downloading a file for.
 *
 * This used to fail open unconditionally, which is how treadmill runs got in:
 * an activity with no stream list was downloaded regardless. It now fails
 * CLOSED for anything indoor-looking and stays permissive only for activities
 * that look outdoor:
 *
 *   indoor-looking            → false, whatever the stream list says
 *   zero/near-zero distance   → false (nothing to draw)
 *   stream list present       → must name a position stream
 *   stream list absent        → true, and a missing track is caught after parse
 *
 * `stream_types` members are not enumerated in the OpenAPI document, so the
 * name match is a heuristic — which is exactly why it is not the only check.
 */
function hasTrack(activity: IntervalsActivity): boolean {
  if (isIndoor(activity)) return false;

  const distance = activity.distance ?? activity.icu_distance ?? 0;
  if (distance < MIN_INGESTED_DISTANCE_METERS) return false;

  if (!activity.stream_types?.length) return true;
  return activity.stream_types.some((stream) => /lat|lng|lon|position|gps|coord/i.test(stream));
}

function toSummary(activity: IntervalsActivity): SourceActivitySummary {
  return {
    sourceActivityId: String(activity.id),
    startedAt: toInstant(activity),
    timezone: activity.timezone,
    name: activity.name?.trim() || "intervals.icu activity",
    sourceSport: activity.type,
    sport: toCanonicalSport(activity.type),
    indoor: isIndoor(activity),
    uploadSource: activity.source,
    distanceMeters: Math.round(activity.distance ?? activity.icu_distance ?? 0),
    durationSeconds: Math.round(activity.moving_time ?? activity.elapsed_time ?? 0),
    elevationGainMeters: Math.round(activity.total_elevation_gain ?? 0),
    hasTrack: hasTrack(activity),
  };
}

/** `oldest`/`newest` take a local ISO date-time with no offset suffix. */
function toLocalIso(iso: string): string {
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, "");
}

export const intervalsIcuSource: ActivitySource = {
  id: "intervals_icu",
  displayName: "intervals.icu",

  async connect(input: ActivitySourceConnectInput): Promise<ConnectResult> {
    // Path 1: OAuth, for any user of the product.
    if (input.code) {
      const token = await exchangeIntervalsCode(input.code);
      if (!token.access_token) throw new Error("intervals.icu token response missing access_token");

      const athleteId = token.athlete?.id
        ? String(token.athlete.id)
        : (await getIntervalsAthlete({ accessToken: token.access_token })).id;

      return {
        externalId: athleteId,
        displayName: token.athlete?.name,
        scope: token.scope,
        accessToken: token.access_token,
      };
    }

    // Path 2: personal API key, so the owner can use his own account before the
    // OAuth app is approved. Validated immediately so a bad key fails loudly.
    if (input.apiKey) {
      const athlete = await getIntervalsAthlete({ apiKey: input.apiKey });
      return {
        externalId: athlete.id,
        displayName: athlete.name,
        scope: "API_KEY",
        apiKey: input.apiKey,
      };
    }

    throw new Error("intervals.icu connect requires an OAuth code or an API key");
  },

  async disconnect(credentials: SourceCredentials): Promise<void> {
    // Only the OAuth grant is ours to revoke. A personal API key belongs to the
    // user and is revoked by them in intervals.icu settings; we just drop it.
    if (!credentials.accessToken) return;

    try {
      await disconnectIntervalsApp({ accessToken: credentials.accessToken });
    } catch (error) {
      // An already-revoked or expired token is a success for our purposes.
      if (error instanceof IntervalsApiError && (error.status === 401 || error.status === 403)) return;
      throw error;
    }
  },

  async listActivitiesSince(
    credentials: SourceCredentials,
    cursor: ActivityCursor,
  ): Promise<ActivityListPage> {
    const athleteId = credentials.externalId ?? "0";
    const until = cursor.until ?? new Date().toISOString();

    const activities = await listIntervalsActivities(toAuth(credentials), {
      athleteId,
      oldest: toLocalIso(cursor.since),
      newest: toLocalIso(until),
      limit: Math.min(cursor.limit ?? MAX_LIST_LIMIT, MAX_LIST_LIMIT),
    });

    return {
      activities: activities.map(toSummary),
      // Resume from the end of the window just covered, not from the newest
      // activity seen: an activity uploaded late would otherwise be skipped.
      nextCursor: { since: until },
    };
  },

  async fetchActivityFile(
    credentials: SourceCredentials,
    sourceActivityId: string,
  ): Promise<SourceActivityFile | null> {
    try {
      const content = await downloadIntervalsGpx(toAuth(credentials), sourceActivityId);
      if (!content.trim()) return null;
      return { format: "gpx", content };
    } catch (error) {
      // 404 means the activity has no downloadable track: skip, do not fail the
      // whole sync over one activity.
      if (error instanceof IntervalsApiError && error.status === 404) return null;
      throw error;
    }
  },

  normalize(input: NormalizeInput): NormalizedActivity {
    const { summary, file } = input;
    const track = parseTrackFile(file.content, file.format);

    // Elevation and time only. Heart rate is never read from the file.
    const samples: RouteMetricSample[] = track.points.map((point) => {
      const sample: RouteMetricSample = { coordinate: [point.lng, point.lat] };
      if (point.elevation !== undefined) sample.elevation = point.elevation;
      if (point.time) sample.time = point.time;
      return sample;
    });

    return {
      ownerUid: input.ownerUid,
      source: "intervals_icu",
      sourceActivityId: summary.sourceActivityId,
      // Prefer the timestamp inside the file: it is the device's own clock.
      startedAt: track.startedAt ?? summary.startedAt,
      timezone: summary.timezone,
      sport: summary.sport,
      sourceSport: summary.sourceSport,
      indoor: summary.indoor,
      uploadSource: summary.uploadSource,
      name: summary.name,
      // Provider summaries are authoritative where present; parsed values are
      // the fallback so a sparse summary still produces a usable activity.
      distanceMeters: summary.distanceMeters || track.distanceMeters,
      durationSeconds: summary.durationSeconds || track.durationSeconds || 0,
      elevationGainMeters: summary.elevationGainMeters || track.elevationGainMeters,
      coordinates: track.coordinates,
      samples: samples.length ? samples : undefined,
    };
  },
};
