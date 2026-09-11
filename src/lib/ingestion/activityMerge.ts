import type { ActivitySourceId, CanonicalActivity, GPXRoute } from "@/app/types";
import { decideStoredActivityScope } from "./sportPolicy";
import {
  DUPLICATE_START_WINDOW_MS,
  isSameRun,
  sampleAlongDistance,
  type RunIdentity,
} from "./trackSignature";

/**
 * The read-layer merge: one list of runs from two collections.
 *
 * Storage stays single-source. Nothing here writes, copies or deletes — a run
 * the owner uploaded by hand and the same run arriving from intervals.icu are
 * two records that keep existing, and collapsing them is a DISPLAY decision
 * only. That matters beyond tidiness: GDPR erasure and provider disconnect
 * (`erasure.ts`) delete by `activity.source`, so a record that was silently
 * copied somewhere else would survive an erasure the user asked for.
 *
 * Two different jobs, deliberately kept apart:
 *
 *   1. JOIN, which is exact. A route the spine wrote carries `activity.id`
 *      pointing at its `CanonicalActivity`; the activity carries `trackRef`
 *      pointing back. That is a key relationship, not a guess, so it is
 *      resolved by id and never by geometry.
 *
 *   2. DEDUPE, which is fuzzy, and only ever between records that have no such
 *      key between them — the owner's manually uploaded GPX versus the same
 *      outing synced from a provider. This calls `isSameRun` from
 *      `trackSignature.ts`. There is no second matching algorithm in this file
 *      and there must never be one: the server ingests with those tolerances,
 *      so the client has to agree with them exactly or the two layers will
 *      disagree about what a duplicate is.
 */

// ─── Provenance ──────────────────────────────────────────────────────────────

export type RunOrigin = "manual_upload" | "provider_sync";

export type RunProvenance = {
  origin: RunOrigin;
  source: ActivitySourceId;
  /** Short human label, e.g. "intervals.icu" or "Uploaded GPX". */
  label: string;
  /** Material Symbols icon name, matching the icon set the UI already uses. */
  icon: string;
  /** Canonical activity id, when the record came through the ingestion spine. */
  activityId?: string;
};

const SOURCE_PRESENTATION: Record<ActivitySourceId, { label: string; icon: string }> = {
  intervals_icu: { label: "intervals.icu", icon: "sync" },
  strava: { label: "Strava", icon: "sync" },
  garmin: { label: "Garmin", icon: "sync" },
  apple_health: { label: "Apple Health", icon: "sync" },
  file_upload: { label: "Uploaded GPX", icon: "upload_file" },
};

function provenanceFor(source: ActivitySourceId, activityId?: string): RunProvenance {
  const presentation = SOURCE_PRESENTATION[source] ?? SOURCE_PRESENTATION.file_upload;
  return {
    origin: source === "file_upload" ? "manual_upload" : "provider_sync",
    source,
    label: presentation.label,
    icon: presentation.icon,
    ...(activityId ? { activityId } : {}),
  };
}

/**
 * Where one route document came from.
 *
 * `activity` is set by the ingestion spine. `strava` is the older, pre-spine
 * Strava sync, which never wrote a canonical activity — it is still a provider
 * sync and must not be labelled as the owner's own upload. Everything else is
 * a manual upload.
 */
export function routeProvenance(route: GPXRoute): RunProvenance {
  if (route.activity) return provenanceFor(route.activity.source, route.activity.id);
  if (route.strava) return provenanceFor("strava");
  return provenanceFor("file_upload");
}

// ─── Unified run ─────────────────────────────────────────────────────────────

/**
 * A route as the pages already consume it, plus who it came from.
 *
 * It extends `GPXRoute` rather than replacing it so the map, the route engine,
 * the filters and the badge rules keep working untouched — a page that ignores
 * the extra fields behaves exactly as it did before.
 */
export type UnifiedRun = GPXRoute & {
  /** The record that won, and is the one being displayed. */
  provenance: RunProvenance;
  /**
   * Other sources that also hold this run, collapsed into this row. Display
   * only: every one of these records still exists in Firestore untouched.
   */
  alsoFrom: RunProvenance[];
  /**
   * Route document ids collapsed into this entry. Kept so the UI can be honest
   * about what it hid, and so nothing has to be guessed again later. These
   * documents are NOT deleted.
   */
  collapsedRouteIds: string[];
};

type Candidate = {
  run: UnifiedRun;
  identity: RunIdentity;
  /** How much this record is worth keeping as the visible one. */
  richness: number;
  startMs: number;
};

/**
 * Which of two recordings of one run should be the one the owner sees.
 *
 * Ranked by what CANNOT be recovered from the other record:
 *
 *   Metric samples first. Heart rate and pace only ever exist on a manually
 *   uploaded TCX — the ingestion spine deliberately never stores them (Art. 9
 *   minimisation, see `types.ts`). If a synced record displaced a manual one,
 *   the pace and heart-rate heatmaps would silently lose that run.
 *
 *   Then canonical linkage, which makes export and erasure able to find every
 *   artefact of the run. It ranks lower only because it is not lost when the
 *   other record wins: the losing provenance is preserved in `alsoFrom`.
 *
 *   Then duration, then track resolution, both of which are merely nicer.
 */
function richnessScore(route: GPXRoute): number {
  let score = 0;
  const hasMetrics = route.hasTcx
    || Boolean(route.samples?.some((sample) => sample.heartRate !== undefined || sample.paceMinPerKm !== undefined));
  if (hasMetrics) score += 16;
  if (route.activity) score += 8;
  if (route.duration) score += 4;
  if (route.samples?.length) score += 2;
  if (route.coordinates.length > 0) score += 1;
  return score;
}

/**
 * `GPXRoute.duration` is minutes; `RunIdentity.durationSeconds` is seconds.
 * Converted here rather than at the comparison so the tolerance constants in
 * `trackSignature.ts` keep meaning what they say.
 */
function identityFor(route: GPXRoute, activity?: CanonicalActivity): RunIdentity {
  const durationSeconds = activity?.durationSeconds
    ?? (typeof route.duration === "number" ? Math.round(route.duration * 60) : undefined);

  return {
    startedAt: route.date,
    distanceMeters: route.distance || 0,
    ...(durationSeconds ? { durationSeconds } : {}),
    ...(activity?.fingerprint ? { fingerprint: activity.fingerprint } : {}),
    ...(route.startPoint || route.coordinates[0]
      ? { startPoint: route.startPoint ?? route.coordinates[0] }
      : {}),
    // Sampled ONCE per record, here. `isSameRun` is called many times per
    // record during bucketing, and re-walking a 4,000-point track inside each
    // comparison is what would actually make this expensive.
    ...(route.coordinates.length > 1
      ? { sampledTrack: sampleAlongDistance(route.coordinates) }
      : {}),
  };
}

function mergeProvenance(existing: RunProvenance[], incoming: RunProvenance[], winner: RunProvenance): RunProvenance[] {
  const seen = new Set<string>([winner.source]);
  const merged: RunProvenance[] = [];

  for (const provenance of [...existing, ...incoming]) {
    if (seen.has(provenance.source)) continue;
    seen.add(provenance.source);
    merged.push(provenance);
  }

  return merged;
}

/** Collapse two records of one run into the richer one. Nothing is deleted. */
function collapse(a: Candidate, b: Candidate): Candidate {
  const [winner, loser] = a.richness >= b.richness ? [a, b] : [b, a];

  return {
    ...winner,
    run: {
      ...winner.run,
      alsoFrom: mergeProvenance(
        winner.run.alsoFrom,
        [loser.run.provenance, ...loser.run.alsoFrom],
        winner.run.provenance,
      ),
      collapsedRouteIds: Array.from(new Set([
        ...winner.run.collapsedRouteIds,
        ...loser.run.collapsedRouteIds,
        loser.run.id,
      ])),
    },
  };
}

// ─── Bucketing ───────────────────────────────────────────────────────────────

/**
 * Bucket width equals the matching window, so two records of one run are never
 * more than one bucket apart and a boundary straddle is covered by looking at
 * the neighbours.
 */
const BUCKET_MS = DUPLICATE_START_WINDOW_MS;

function bucketOf(startMs: number): number {
  return Math.floor(startMs / BUCKET_MS);
}

/**
 * Merge the two collections into one chronological list.
 *
 * COST. Naively this is O(n²): every run compared with every other run, which
 * on a decade of training is millions of haversine calls on every render. It is
 * not done that way.
 *
 * `isSameRun` cannot match anything whose start times differ by more than
 * `DUPLICATE_START_WINDOW_MS` (10 minutes) — it returns false on that check
 * before touching geometry. So records are bucketed by start time into 10
 * minute bins and each record is compared only against the bin it lands in and
 * its two neighbours. Everything outside that is provably not a match and is
 * never compared.
 *
 * That makes the pass O(n · k), where k is the number of runs the owner started
 * within roughly 20 minutes of each other. For one person's training history k
 * is 1 or 2 — you cannot run two runs at once, and the whole point of the
 * exercise is the manual copy and the synced copy of the SAME outing — so this
 * is linear in practice. Geometry sampling is done once per record, not once
 * per comparison, so the dominant term is O(total track points), which is the
 * same order as simply having loaded the routes.
 */
export function mergeActivityRecords(input: {
  routes: GPXRoute[];
  activities: CanonicalActivity[];
}): UnifiedRun[] {
  const { routes, activities } = input;

  // 1. Index the canonical records.
  const activityById = new Map<string, CanonicalActivity>();
  for (const activity of activities) activityById.set(activity.id, activity);

  // 2. Exact join, by key. A spine-written route names its activity; fall back
  //    to the activity's own `trackRef` for records written before that link
  //    existed.
  const activityByRouteId = new Map<string, CanonicalActivity>();
  for (const route of routes) {
    const linked = route.activity ? activityById.get(route.activity.id) : undefined;
    if (linked) activityByRouteId.set(route.id, linked);
  }
  for (const activity of activities) {
    const routeId = activity.trackRef?.id;
    if (routeId && !activityByRouteId.has(routeId)) activityByRouteId.set(routeId, activity);
  }

  // 3. Duplicates the SERVER already resolved. `store.ts` records a
  //    cross-provider duplicate as an activity with `duplicateOf` and writes no
  //    second route, so the only trace of "intervals.icu also has this run" is
  //    here. Surfacing it is the difference between a correct provenance line
  //    and a misleading one.
  const extraProvenanceByActivityId = new Map<string, RunProvenance[]>();
  for (const activity of activities) {
    if (!activity.duplicateOf) continue;
    const existing = extraProvenanceByActivityId.get(activity.duplicateOf) ?? [];
    existing.push(provenanceFor(activity.source, activity.id));
    extraProvenanceByActivityId.set(activity.duplicateOf, existing);
  }

  // 4. Build one candidate per route document.
  const candidates: Candidate[] = [];
  for (const route of routes) {
    const activity = activityByRouteId.get(route.id);

    // THE sport policy, applied to what we already hold. A treadmill run
    // ingested before that policy existed still has a route document and would
    // otherwise sit on the map until the reconciliation pass runs. This hides
    // it; it does not delete it, and it asks `sportPolicy.ts` rather than
    // re-deciding anything locally. Manual uploads are never judged here — the
    // owner chose to upload them and they carry no sport to judge.
    if (activity && !decideStoredActivityScope(activity).ingest) continue;

    const startMs = new Date(route.date).valueOf();
    const provenance = routeProvenance(route);

    candidates.push({
      run: {
        ...route,
        provenance,
        alsoFrom: mergeProvenance(
          [],
          activity ? extraProvenanceByActivityId.get(activity.id) ?? [] : [],
          provenance,
        ),
        collapsedRouteIds: [],
      },
      identity: identityFor(route, activity),
      richness: richnessScore(route),
      startMs: Number.isFinite(startMs) ? startMs : 0,
    });
  }

  // 5. Bucketed dedupe. Newest first, so the order of the output falls out of
  //    the pass rather than needing a second sort of a mutated list.
  candidates.sort((a, b) => b.startMs - a.startMs);

  const buckets = new Map<number, Candidate[]>();
  const place = (candidate: Candidate) => {
    const key = bucketOf(candidate.startMs);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(candidate);
    else buckets.set(key, [candidate]);
  };

  for (const candidate of candidates) {
    const key = bucketOf(candidate.startMs);
    let merged = false;

    for (let offset = -1; offset <= 1 && !merged; offset += 1) {
      const neighbours = buckets.get(key + offset);
      if (!neighbours) continue;

      for (let i = 0; i < neighbours.length; i += 1) {
        const held = neighbours[i];

        // Two records already joined to the SAME canonical activity are the
        // same row by key and never reach here. Two records from the same
        // source are the provider's business, not ours: `store.ts` settles
        // those by document id, and collapsing them here would hide a genuine
        // double-entry the owner may want to see.
        if (held.run.provenance.source === candidate.run.provenance.source) continue;
        if (!isSameRun(held.identity, candidate.identity)) continue;

        // Re-placed rather than written back in place: the survivor keeps the
        // WINNER's start time, which may belong to a different bin than the one
        // it was found in. Every placed candidate must sit in the bin its own
        // start time hashes to, or a third recording of the same run could end
        // up two bins away and never be compared.
        neighbours.splice(i, 1);
        place(collapse(held, candidate));
        merged = true;
        break;
      }
    }

    if (!merged) place(candidate);
  }

  const runs: UnifiedRun[] = [];
  for (const bucket of buckets.values()) {
    for (const candidate of bucket) runs.push(candidate.run);
  }

  runs.sort((a, b) => new Date(b.date).valueOf() - new Date(a.date).valueOf());
  return runs;
}

/** How many displayed runs are held by more than one source. */
export function countCollapsedRuns(runs: UnifiedRun[]): number {
  return runs.reduce((total, run) => total + (run.alsoFrom.length > 0 ? 1 : 0), 0);
}
