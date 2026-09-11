import type { CanonicalActivity, CanonicalSport, SourceActivitySummary } from "@/app/types";

/**
 * THE sport policy.
 *
 * One named, exported decision point for "does this activity belong in GPX
 * Runner at all?". Everything that used to be a scattered conditional — the
 * eligible-sport list in `sync.ts`, the track check in the adapter, the
 * empty-coordinates guard in `store.ts` — asks this module instead, so the
 * answer cannot drift between the paths.
 *
 * The product is about running *outdoors*. A treadmill run is a real workout
 * and belongs in the owner's training log; it is not a route, it has no
 * geometry, and it must never reach a map, a heatmap, a familiarity score or a
 * badge. The policy therefore fails CLOSED: anything that looks indoor is
 * rejected before a file is ever downloaded.
 *
 * ── Extending it ─────────────────────────────────────────────────────────────
 * To add cycling later, add `'ride'` to `INGESTED_SPORTS` below (and map the
 * provider's `Ride`/`GravelRide`/`MountainBikeRide` types onto it in the
 * adapter). That is the whole change: the sync loop, the ingest guard and the
 * reconciliation pass all read this list. Do NOT add `VirtualRide` — indoor
 * cycling is out of scope for exactly the same reason treadmill running is.
 */

/**
 * Canonical sports GPX Runner ingests, outdoors only.
 *
 * `walk` and `hike` were previously ingested. They are deliberately out now:
 * the product's purpose is running, and a narrow list is the thing that makes
 * "why is this in my history?" answerable. Re-adding them is a one-line change.
 */
export const INGESTED_SPORTS: readonly CanonicalSport[] = ["run", "trail_run"];

/**
 * Below this, there is nothing to draw. A treadmill run that slipped through
 * every other check still reports ~0 m of GPS distance, so this is the last
 * line of defence rather than the first.
 */
export const MIN_INGESTED_DISTANCE_METERS = 100;

/**
 * Provider sport labels that are indoor/virtual by definition.
 *
 * Verified against the intervals.icu OpenAPI document (`SportInfo.type` enum,
 * https://intervals.icu/api/v1/docs). Listed explicitly rather than pattern
 * matched so a new provider value fails the `INGESTED_SPORTS` check loudly
 * instead of being silently accepted by a regex that did not anticipate it.
 */
const INDOOR_SOURCE_SPORTS = new Set([
  "VirtualRun",
  "VirtualRide",
  "VirtualRow",
  "VirtualSki",
  "Elliptical",
  "StairStepper",
  "Crossfit",
  "WeightTraining",
  "Yoga",
  "Pilates",
  "HighIntensityIntervalTraining",
  "Workout",
]);

/**
 * Upload sources that only ever produce indoor activities.
 *
 * Verified against the intervals.icu OpenAPI document (`Activity.source` enum).
 * ZWIFT is a virtual-world platform: every activity it delivers is indoor, and
 * a Zwift run carries a synthetic GPS trace of a virtual island, which is
 * exactly the kind of track that would otherwise look outdoor to a geometry
 * check.
 */
const INDOOR_UPLOAD_SOURCES = new Set(["ZWIFT"]);

export type ScopeRejectionReason =
  | "sport_not_ingested"
  | "indoor_activity"
  | "no_gps_track"
  | "no_distance";

export type ScopeDecision =
  | { ingest: true }
  | { ingest: false; reason: ScopeRejectionReason; detail?: string };

/**
 * Everything the policy needs to know. Deliberately a structural type rather
 * than one of the concrete models, so the same function can judge a provider
 * summary before download, a normalised activity at ingest time, and a record
 * already sitting in Firestore during reconciliation.
 */
export type ActivityScopeInput = {
  sport: CanonicalSport;
  /** Raw provider sport label, e.g. `VirtualRun`. */
  sourceSport?: string;
  /** Provider's own indoor/trainer marker, when it reports one. */
  indoor?: boolean;
  /** Provider's upload source, e.g. `GARMIN_CONNECT`, `ZWIFT`. */
  uploadSource?: string;
  /**
   * Whether a usable GPS track exists. `undefined` means "the provider did not
   * say" and stays permissive — but only for activities that are not otherwise
   * indoor-flagged, which is what makes the check fail closed where it matters.
   */
  hasTrack?: boolean;
  distanceMeters?: number;
};

export function isIngestedSport(sport: CanonicalSport): boolean {
  return INGESTED_SPORTS.includes(sport);
}

/** True when anything about the activity says "this happened indoors". */
export function looksIndoor(input: ActivityScopeInput): boolean {
  if (input.indoor === true) return true;
  if (input.sourceSport && INDOOR_SOURCE_SPORTS.has(input.sourceSport)) return true;
  if (input.uploadSource && INDOOR_UPLOAD_SOURCES.has(input.uploadSource)) return true;
  return false;
}

/**
 * The decision. Ordered so the cheapest and most certain rejections come first
 * and the reason returned is the most useful one to show a human.
 */
export function decideActivityScope(input: ActivityScopeInput): ScopeDecision {
  if (looksIndoor(input)) {
    return {
      ingest: false,
      reason: "indoor_activity",
      detail: input.sourceSport ?? input.uploadSource,
    };
  }

  if (!isIngestedSport(input.sport)) {
    return { ingest: false, reason: "sport_not_ingested", detail: input.sourceSport ?? input.sport };
  }

  if ((input.distanceMeters ?? 0) < MIN_INGESTED_DISTANCE_METERS) {
    return { ingest: false, reason: "no_distance" };
  }

  // `undefined` is "unknown", and an outdoor run whose stream list the provider
  // simply did not report is still worth fetching. Only an explicit "no" stops
  // us here; a missing track is caught again after parsing.
  if (input.hasTrack === false) {
    return { ingest: false, reason: "no_gps_track" };
  }

  return { ingest: true };
}

/** Convenience wrapper for the sync loop, which holds provider summaries. */
export function decideSummaryScope(summary: SourceActivitySummary): ScopeDecision {
  return decideActivityScope({
    sport: summary.sport,
    sourceSport: summary.sourceSport,
    indoor: summary.indoor,
    uploadSource: summary.uploadSource,
    hasTrack: summary.hasTrack,
    distanceMeters: summary.distanceMeters,
  });
}

/**
 * Judge a record we already hold. Used by the reconciliation pass to find
 * activities ingested before this policy existed — the treadmill runs that are
 * sitting in the app today.
 */
export function decideStoredActivityScope(
  activity: Pick<CanonicalActivity, "sport" | "distanceMeters"> &
    Partial<Pick<CanonicalActivity, "sourceSport" | "indoor" | "uploadSource" | "trackRef">>,
): ScopeDecision {
  return decideActivityScope({
    sport: activity.sport,
    sourceSport: activity.sourceSport,
    indoor: activity.indoor,
    uploadSource: activity.uploadSource,
    // A stored record's track either has points or it does not; there is no
    // "unknown" once it is in Firestore.
    hasTrack: (activity.trackRef?.pointCount ?? 0) > 0,
    distanceMeters: activity.distanceMeters,
  });
}

/** Human-readable reason, for the sync report and the reconciliation preview. */
export function describeScopeRejection(reason: ScopeRejectionReason, detail?: string): string {
  switch (reason) {
    case "indoor_activity":
      return detail ? `Indoor or virtual activity (${detail})` : "Indoor or virtual activity";
    case "sport_not_ingested":
      return detail ? `Sport not ingested (${detail})` : "Sport not ingested";
    case "no_distance":
      return "No usable distance";
    case "no_gps_track":
      return "No GPS track";
  }
}
