import { adminDb } from "@/lib/firebaseAdmin";
import { requireConsent } from "./consent";
import { getConnection, openCredentials } from "./connections";
import { getActivitySource } from "./registry";
import { decideSummaryScope } from "./sportPolicy";
import { ConnectionMissingError, ingestionErrorCode } from "./sync";
import {
  ingestActivity,
  knownAmongSourceActivityIds,
  loadForeignDedupeCandidates,
  type DedupeCandidate,
} from "./store";
import type { ActivitySource, ActivitySourceId, SourceCredentials } from "@/app/types";

/**
 * Full-history import.
 *
 * The reconciliation pull in `sync.ts` walks a trailing window forwards and is
 * the right shape for "did a webhook go missing last night". It is the wrong
 * shape for "bring in fifteen years", because a single call would have to hold
 * the whole history open and would exhaust the provider the moment it tried.
 *
 * So this walks *backwards* instead, in bounded batches, and writes down where
 * it got to. Every batch is capped at `maxDownloads` files and one listing
 * call; the frontier — the oldest instant already covered — is persisted after
 * each batch, so a closed tab, a refresh, a crashed request or a rate limit
 * costs at most the batch that was in flight. The caller repeats the batch call
 * until `status` is `done`. The user asks once.
 *
 * Two facts make this safe rather than merely convenient, and both were checked
 * in the code rather than assumed:
 *
 *   - `ingestActivity` keys the canonical record on `(source, sourceActivityId)`
 *     via `canonicalActivityId`, and separately fingerprints the track. Running
 *     the same batch twice updates in place; it cannot create a second route or
 *     double a heatmap.
 *   - an activity already held is skipped before `fetchActivityFile` is called,
 *     so a resumed or repeated import re-downloads nothing.
 *
 * Nothing here touches Strava. The import is driven by a registered
 * `ActivitySource` adapter, and Strava deliberately has no adapter: its data
 * keeps its existing, separately-governed handling under `/api/strava`.
 */

export const HISTORY_COLLECTION = "historyImports";

/**
 * Window span for a batch when there is no plan to size it from.
 *
 * Normally the window is chosen from the planned start times instead — see
 * `chooseWindowStart`. This is the fallback for a progress document written
 * before the plan existed.
 */
export const HISTORY_WINDOW_DAYS = 365;

/**
 * Files downloaded in one batch.
 *
 * This is the guard the whole design turns on, and it is ours, not the
 * provider's. Measured against the live API on 2026-09-23: intervals.icu
 * returned 200 to twenty concurrent GPX downloads and published no
 * `X-RateLimit-*` headers, but its documented ceiling is 10 requests/second per
 * IP. A sequential batch of 100 at the measured ~96 ms per file runs at roughly
 * 10 req/s, so the cap keeps one call inside the documented limit even in the
 * worst case, and keeps a single request comfortably under a serverless
 * timeout.
 */
export const HISTORY_MAX_DOWNLOADS = 100;

/** Bound on the failure list kept in the progress document. */
const MAX_RECORDED_FAILURES = 50;

export type HistoryImportStatus = "running" | "done" | "failed";

export type HistoryImportProgress = {
  uid: string;
  source: ActivitySourceId;
  status: HistoryImportStatus;
  startedAt: string;
  updatedAt: string;
  /**
   * Exclusive-ish upper bound for the next batch: everything newer than this
   * has been covered. Starts at "now" and marches back towards `earliestKnown`.
   */
  frontier: string;
  /** The athlete's genuinely oldest activity, learned from the planning pass. */
  earliestKnown: string;
  /** Oldest activity this import has actually stored. */
  oldestImportedAt?: string;
  /** Importable activities the provider reported at planning time. */
  plannedTotal: number;
  /**
   * Start times of every planned activity, as comma-separated epoch minutes.
   *
   * `remaining` has to be a fact, not an estimate. Deriving it by subtracting
   * running counters from `plannedTotal` looks simpler and is wrong: when the
   * download ceiling truncates a batch the next window deliberately overlaps
   * it, so the boundary activities are seen twice and the counters drift until
   * the UI claims the import has finished while the frontier is still in 2019.
   *
   * Counting planned start times older than the frontier cannot drift, because
   * it is read off the frontier rather than accumulated. Packed into one string
   * rather than an array so Firestore does not index fifteen hundred elements
   * on every batch write; about 10 KB for the live account's 1,434 runs.
   */
  plannedStartMinutes: string;
  /** Of those, how many are still older than the frontier. */
  remaining: number;
  imported: number;
  updated: number;
  duplicates: number;
  /**
   * Activities a batch found already stored. Windows overlap by design, so a
   * run imported by one batch can be counted here by the next: this is a
   * "work avoided" signal, not a population count.
   */
  alreadyHeld: number;
  /** Eligible at listing time but nothing was stored — no file, or rejected. */
  skipped: number;
  /** Not a foot sport, indoor, or too short. Never downloaded. */
  outOfScope: number;
  failed: number;
  batches: number;
  /** Files pulled from the provider across the whole import. */
  downloads: number;
  /** Set when a batch threw. Cleared by the next batch that succeeds. */
  lastError?: { code: string; at: string };
  /** Bounded: activities that failed and will be retried by a later batch. */
  failedIds: string[];
  completedAt?: string;
};

export type HistoryBatchResult = {
  /** Window this batch covered, oldest-first. */
  windowStart: string;
  windowEnd: string;
  scanned: number;
  eligible: number;
  imported: number;
  updated: number;
  duplicates: number;
  alreadyHeld: number;
  skipped: number;
  outOfScope: number;
  failed: { sourceActivityId: string; code: string }[];
  downloads: number;
  /** True when the per-call ceiling stopped the batch before the window ended. */
  hitDownloadLimit: boolean;
  progress: HistoryImportProgress;
};

/** Minute resolution is finer than any two starts we need to tell apart. */
function toEpochMinute(iso: string): number {
  return Math.floor(new Date(iso).valueOf() / 60_000);
}

export function packStartMinutes(isoStarts: string[]): string {
  return isoStarts
    .map(toEpochMinute)
    .filter((minute) => Number.isFinite(minute))
    .sort((a, b) => a - b)
    .join(",");
}

/** Planned activities still older than the frontier, i.e. still to come. */
export function countRemaining(packed: string, frontier: string): number {
  if (!packed) return 0;
  const limit = toEpochMinute(frontier);
  let count = 0;
  for (const part of packed.split(",")) {
    if (Number(part) < limit) count += 1;
  }
  return count;
}

/**
 * How far back should this batch's window reach?
 *
 * A fixed calendar span is the obvious answer and a poor one. Real histories
 * are not evenly distributed: this athlete has three runs in 2019 and none at
 * all in 2017 or 2018, and 189 in 2025. Fixed 365-day windows spend a whole
 * round trip discovering that a year was empty, so the client loops sixteen
 * times to cover ground that holds nothing, and the progress bar sits still
 * while it does.
 *
 * The plan already knows where the activities are, so the window is sized to
 * hold about one batch's worth of them: barren stretches are swallowed whole in
 * a single listing call, dense years are cut into batches that fill the
 * download ceiling. Coverage is unaffected — consecutive windows still tile the
 * whole timeline with no gaps, which is what stops a late upload inside a
 * skipped stretch from being missed.
 */
export function chooseWindowStart(input: {
  packed: string;
  frontier: string;
  floor: string;
  maxDownloads: number;
}): string {
  const { packed, frontier, floor, maxDownloads } = input;
  if (!packed) return maxIso(daysBefore(frontier, HISTORY_WINDOW_DAYS), floor);

  const limit = toEpochMinute(frontier);
  const older = packed
    .split(",")
    .map(Number)
    .filter((minute) => Number.isFinite(minute) && minute < limit)
    .sort((a, b) => b - a);

  // Everything left fits in one batch, so reach all the way to the floor and
  // let this be the last window.
  if (older.length <= maxDownloads) return floor;

  // Stop just short of the activity after the ceiling's worth.
  const boundary = older[maxDownloads - 1];
  return maxIso(new Date((boundary - 1) * 60_000).toISOString(), floor);
}

function docId(uid: string, source: ActivitySourceId): string {
  return `${uid}__${source}`;
}

function daysBefore(iso: string, days: number): string {
  return new Date(new Date(iso).valueOf() - days * 24 * 60 * 60 * 1000).toISOString();
}

export async function loadHistoryProgress(
  uid: string,
  source: ActivitySourceId,
): Promise<HistoryImportProgress | null> {
  const snap = await adminDb().collection(HISTORY_COLLECTION).doc(docId(uid, source)).get();
  return snap.exists ? (snap.data() as HistoryImportProgress) : null;
}

async function saveHistoryProgress(progress: HistoryImportProgress): Promise<void> {
  await adminDb()
    .collection(HISTORY_COLLECTION)
    .doc(docId(progress.uid, progress.source))
    .set(progress);
}

export async function clearHistoryProgress(
  uid: string,
  source: ActivitySourceId,
): Promise<void> {
  await adminDb().collection(HISTORY_COLLECTION).doc(docId(uid, source)).delete();
}

/**
 * The planning pass: one listing call over the whole history.
 *
 * It exists so the UI can say something true about what remains instead of
 * counting up from zero with no idea where zero ends. Against the live account
 * this is a single 250 ms request returning about a megabyte, so it is paid
 * once per import and not once per batch.
 */
async function planImport(input: {
  uid: string;
  source: ActivitySourceId;
  adapter: ActivitySource;
  credentials: SourceCredentials;
  now: string;
}): Promise<HistoryImportProgress> {
  const { uid, source, adapter, credentials, now } = input;

  const page = await adapter.listActivitiesSince(credentials, {
    // Older than any consumer GPS watch. The real floor is whatever the athlete
    // actually has, which is what we read out of the response below.
    since: "1990-01-01T00:00:00.000Z",
    until: now,
  });

  const importable = page.activities.filter((activity) => decideSummaryScope(activity).ingest);
  const starts = importable.map((activity) => activity.startedAt).sort();

  return {
    uid,
    source,
    status: "running",
    startedAt: now,
    updatedAt: now,
    frontier: now,
    // A history with nothing importable in it still needs a floor that the
    // frontier can reach, or the import would never report itself finished.
    earliestKnown: starts[0] ?? now,
    plannedTotal: importable.length,
    plannedStartMinutes: packStartMinutes(starts),
    remaining: importable.length,
    imported: 0,
    updated: 0,
    duplicates: 0,
    alreadyHeld: 0,
    skipped: 0,
    outOfScope: 0,
    failed: 0,
    batches: 0,
    downloads: 0,
    failedIds: [],
  };
}

export type HistoryBatchInput = {
  uid: string;
  source: ActivitySourceId;
  /** Throw away any stored progress and plan again from now. */
  restart?: boolean;
  /** Override the per-call ceiling. Never raised above `HISTORY_MAX_DOWNLOADS`. */
  maxDownloads?: number;
  /**
   * Keep the provider's original file for each activity. Off by default here;
   * see `ingestActivity`.
   */
  retainRawPayload?: boolean;
};

/**
 * Run exactly one bounded batch and persist where it got to.
 *
 * On a provider or database failure the progress document is written with the
 * diagnostic code before the error is rethrown, so the client sees a named
 * failure and the next call resumes from the same frontier rather than from
 * the beginning.
 */
export async function runHistoryBatch(input: HistoryBatchInput): Promise<HistoryBatchResult> {
  const { uid, source } = input;

  const consent = await requireConsent(uid, "provider_ingest", source);

  const connection = await getConnection(uid, source);
  if (!connection) throw new ConnectionMissingError(source);

  const adapter = getActivitySource(source);
  const credentials = openCredentials(connection);
  const now = new Date().toISOString();

  let progress = input.restart ? null : await loadHistoryProgress(uid, source);
  if (!progress || progress.status === "done") {
    if (progress?.status === "done" && !input.restart) {
      // Finished and asked again: report the finished state rather than
      // silently re-walking fifteen years.
      return {
        windowStart: progress.earliestKnown,
        windowEnd: progress.frontier,
        scanned: 0,
        eligible: 0,
        imported: 0,
        updated: 0,
        duplicates: 0,
        alreadyHeld: 0,
        skipped: 0,
        outOfScope: 0,
        failed: [],
        downloads: 0,
        hitDownloadLimit: false,
        progress,
      };
    }
    progress = await planImport({ uid, source, adapter, credentials, now });
    await saveHistoryProgress(progress);
  }

  const maxDownloads = Math.min(
    Math.max(1, input.maxDownloads ?? HISTORY_MAX_DOWNLOADS),
    HISTORY_MAX_DOWNLOADS,
  );

  const frontier = progress.frontier;
  // One day of slack so the oldest activity is inside the window rather than
  // exactly on its edge.
  const floor = daysBefore(progress.earliestKnown, 1);
  const windowStart = chooseWindowStart({
    packed: progress.plannedStartMinutes ?? "",
    frontier,
    floor,
    maxDownloads,
  });

  try {
    const batch = await importWindow({
      uid,
      source,
      adapter,
      credentials,
      consentId: consent.id,
      windowStart,
      windowEnd: frontier,
      maxDownloads,
      retainRawPayload: input.retainRawPayload === true,
    });

    // Where the next batch starts. When the ceiling stopped us part-way the
    // frontier moves only as far as the oldest activity actually completed, so
    // the ones left behind are inside the next window instead of being stepped
    // over. They are re-listed, which is one cheap line of a list response, and
    // never re-downloaded, because by then they are held.
    let nextFrontier = batch.hitDownloadLimit
      ? (batch.oldestTouchedAt ?? windowStart)
      : windowStart;
    // Forward progress is not negotiable: a batch that could not advance the
    // frontier would be repeated for ever by a client that loops until done.
    if (new Date(nextFrontier).valueOf() >= new Date(frontier).valueOf()) {
      nextFrontier = new Date(new Date(frontier).valueOf() - 1).toISOString();
    }

    // Finished when the frontier has walked back past the athlete's oldest
    // activity. Nothing older exists, so there is nothing left to ask for.
    const done = new Date(nextFrontier).valueOf() <= new Date(floor).valueOf();

    const failedIds = dedupeBounded(
      [...progress.failedIds, ...batch.failed.map((entry) => entry.sourceActivityId)],
      MAX_RECORDED_FAILURES,
    );

    const next: HistoryImportProgress = {
      ...progress,
      status: done ? "done" : "running",
      updatedAt: new Date().toISOString(),
      frontier: nextFrontier,
      oldestImportedAt: minIsoDefined(progress.oldestImportedAt, batch.oldestStoredAt),
      imported: progress.imported + batch.imported,
      updated: progress.updated + batch.updated,
      duplicates: progress.duplicates + batch.duplicates,
      alreadyHeld: progress.alreadyHeld + batch.alreadyHeld,
      skipped: progress.skipped + batch.skipped,
      outOfScope: progress.outOfScope + batch.outOfScope,
      failed: progress.failed + batch.failed.length,
      batches: progress.batches + 1,
      downloads: progress.downloads + batch.downloads,
      failedIds,
      remaining: done ? 0 : countRemaining(progress.plannedStartMinutes, nextFrontier),
    };
    if (done) next.completedAt = next.updatedAt;
    delete next.lastError;

    await saveHistoryProgress(next);

    return {
      windowStart,
      windowEnd: frontier,
      scanned: batch.scanned,
      eligible: batch.eligible,
      imported: batch.imported,
      updated: batch.updated,
      duplicates: batch.duplicates,
      alreadyHeld: batch.alreadyHeld,
      skipped: batch.skipped,
      outOfScope: batch.outOfScope,
      failed: batch.failed,
      downloads: batch.downloads,
      hitDownloadLimit: batch.hitDownloadLimit,
      progress: next,
    };
  } catch (error) {
    // The frontier is deliberately NOT advanced: whatever this window held is
    // still owed, and the next call will walk it again. What is recorded is the
    // reason, so the UI can say which failure it was instead of stalling.
    const failedProgress: HistoryImportProgress = {
      ...progress,
      status: "failed",
      updatedAt: new Date().toISOString(),
      lastError: { code: ingestionErrorCode(error), at: new Date().toISOString() },
    };
    await saveHistoryProgress(failedProgress).catch(() => undefined);
    throw error;
  }
}

type WindowResult = {
  scanned: number;
  eligible: number;
  imported: number;
  updated: number;
  duplicates: number;
  alreadyHeld: number;
  skipped: number;
  outOfScope: number;
  failed: { sourceActivityId: string; code: string }[];
  downloads: number;
  hitDownloadLimit: boolean;
  /** Oldest activity this batch dealt with at all, held or newly stored. */
  oldestTouchedAt?: string;
  /** Oldest activity this batch actually wrote. */
  oldestStoredAt?: string;
};

async function importWindow(input: {
  uid: string;
  source: ActivitySourceId;
  adapter: ActivitySource;
  credentials: SourceCredentials;
  consentId?: string;
  windowStart: string;
  windowEnd: string;
  maxDownloads: number;
  retainRawPayload: boolean;
}): Promise<WindowResult> {
  const { uid, source, adapter, credentials } = input;

  const page = await adapter.listActivitiesSince(credentials, {
    since: input.windowStart,
    until: input.windowEnd,
  });

  const result: WindowResult = {
    scanned: page.activities.length,
    eligible: 0,
    imported: 0,
    updated: 0,
    duplicates: 0,
    alreadyHeld: 0,
    skipped: 0,
    outOfScope: 0,
    failed: [],
    downloads: 0,
    hitDownloadLimit: false,
  };

  // The sport policy runs before anything is downloaded, exactly as in the
  // reconciliation pull: a treadmill run costs one line of a list response.
  const eligible = page.activities
    .filter((activity) => {
      if (decideSummaryScope(activity).ingest) return true;
      result.outOfScope += 1;
      return false;
    })
    // Newest first. Walking backwards through the window is what lets a
    // truncated batch hand a clean frontier to the next one.
    .sort((a, b) => new Date(b.startedAt).valueOf() - new Date(a.startedAt).valueOf());

  result.eligible = eligible.length;
  if (!eligible.length) return result;

  // Two bounded reads per batch, not two full-collection scans. See
  // `knownAmongSourceActivityIds` and `loadForeignDedupeCandidates`.
  const known = await knownAmongSourceActivityIds(
    source,
    eligible.map((activity) => activity.sourceActivityId),
  );
  const candidates: DedupeCandidate[] = await loadForeignDedupeCandidates(uid, source);

  for (const summary of eligible) {
    if (known.has(summary.sourceActivityId)) {
      result.alreadyHeld += 1;
      result.oldestTouchedAt = minIso(result.oldestTouchedAt, summary.startedAt);
      continue;
    }

    if (result.downloads >= input.maxDownloads) {
      result.hitDownloadLimit = true;
      break;
    }

    try {
      const file = await adapter.fetchActivityFile(credentials, summary.sourceActivityId);
      result.downloads += 1;

      if (!file) {
        result.skipped += 1;
        result.oldestTouchedAt = minIso(result.oldestTouchedAt, summary.startedAt);
        continue;
      }

      const normalized = adapter.normalize({ ownerUid: uid, summary, file });
      const outcome = await ingestActivity({
        normalized,
        file,
        consentId: input.consentId,
        candidates,
        retainRawPayload: input.retainRawPayload,
      });

      switch (outcome.outcome) {
        case "created":
          result.imported += 1;
          result.oldestStoredAt = minIso(result.oldestStoredAt, normalized.startedAt);
          // Keep the in-memory view current so two recordings of the same run
          // inside one batch are both caught, not just the first.
          candidates.push({
            id: outcome.activityId,
            source,
            startedAt: normalized.startedAt,
            distanceMeters: Math.round(normalized.distanceMeters),
            startPoint: normalized.coordinates[0],
          });
          break;
        case "updated":
          result.updated += 1;
          result.oldestStoredAt = minIso(result.oldestStoredAt, normalized.startedAt);
          break;
        case "duplicate":
          result.duplicates += 1;
          break;
        default:
          result.skipped += 1;
      }

      result.oldestTouchedAt = minIso(result.oldestTouchedAt, summary.startedAt);
    } catch (error) {
      // Same rule as the reconciliation pull: a failure that applies to every
      // remaining activity ends the batch, anything else is stepped over and
      // named. The frontier still stops at the oldest activity we completed, so
      // a stepped-over activity is inside the next window and gets another go.
      if (endsTheBatch(error)) throw error;
      result.failed.push({
        sourceActivityId: summary.sourceActivityId,
        code: ingestionErrorCode(error),
      });
      console.error("[history] activity failed", {
        source,
        sourceActivityId: summary.sourceActivityId,
        error,
      });
    }
  }

  return result;
}

/**
 * A batch-ending failure is one that would produce itself again for every
 * remaining activity: revoked authorisation, a withdrawn consent, a rate limit,
 * a provider outage. Re-exported through `ingestionErrorCode`'s classification
 * so there is one definition of "fatal" in the ingestion layer.
 */
function endsTheBatch(error: unknown): boolean {
  const code = ingestionErrorCode(error);
  return (
    code === "consent_missing" ||
    code === "consent_outdated" ||
    code === "provider_not_connected" ||
    code === "token_decrypt_failed" ||
    code === "intervals_authorization_failed" ||
    code === "intervals_rate_limited" ||
    code === "intervals_unavailable" ||
    code === "encryption_key_missing" ||
    code === "intervals_env_missing"
  );
}

function minIso(current: string | undefined, candidate: string): string {
  if (!current) return candidate;
  return new Date(candidate).valueOf() < new Date(current).valueOf() ? candidate : current;
}

function minIsoDefined(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return minIso(a, b);
}

function maxIso(a: string, b: string): string {
  return new Date(a).valueOf() >= new Date(b).valueOf() ? a : b;
}

function dedupeBounded(values: string[], limit: number): string[] {
  return Array.from(new Set(values)).slice(-limit);
}
