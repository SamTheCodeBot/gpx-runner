import { IntervalsApiError } from "@/lib/intervals";
import { TokenCryptoError } from "@/lib/tokenCrypto";
import { ConsentError, requireConsent } from "./consent";
import { getConnection, openCredentials, updateCursor } from "./connections";
import { getActivitySource } from "./registry";
import { decideSummaryScope } from "./sportPolicy";
import {
  ingestActivity,
  knownSourceActivityIds,
  loadDedupeCandidates,
  type IngestOutcome,
} from "./store";
import type { ActivitySourceId } from "@/app/types";

/**
 * Provider-agnostic ingestion run.
 *
 * Both entry points use this: the cursor-based reconciliation pull and the
 * webhook. A webhook is only a hint that something changed \u2014 it passes the ids
 * it was told about, and everything after that is the same path, so a missed or
 * malformed webhook can never produce data that a later pull would not.
 */

const DEFAULT_LOOKBACK_DAYS = 30;

export type IngestionRunInput = {
  uid: string;
  source: ActivitySourceId;
  /** Reconciliation window, in days back from now. */
  lookbackDays?: number;
  /** Restrict the run to these provider ids (webhook path). */
  onlySourceActivityIds?: string[];
  /** Re-download activities we already hold. Off by default. */
  force?: boolean;
  /** Cap on files downloaded in one run, to stay inside rate limits. */
  maxDownloads?: number;
};

export type IngestionRunResult = {
  source: ActivitySourceId;
  scanned: number;
  eligible: number;
  imported: number;
  updated: number;
  duplicates: number;
  skipped: { sourceActivityId: string; reason: string }[];
  /** Activities that threw and were stepped over, with their diagnostic code. */
  failed: { sourceActivityId: string; code: string }[];
  windowStart: string;
  windowEnd: string;
};

/**
 * Does this error end the whole run, or just this activity?
 *
 * A revoked token, a withdrawn consent or a rate limit applies to every
 * remaining activity, so carrying on would only burn requests and produce the
 * same failure n more times. Anything else — one unreadable file, one activity
 * whose write the database refused — is that activity's problem alone, and
 * stopping on it would strand every later run behind it. That is what made a
 * single bad activity look like "the sync is broken": the loop wrote the runs
 * before it, threw on that one, and never reached the rest.
 */
function endsTheRun(error: unknown): boolean {
  if (error instanceof ConsentError) return true;
  if (error instanceof ConnectionMissingError) return true;
  if (error instanceof TokenCryptoError) return true;
  if (error instanceof IntervalsApiError) {
    return error.status === 401 || error.status === 403 || error.status === 429 || error.status >= 500;
  }
  return false;
}

export async function runIngestion(input: IngestionRunInput): Promise<IngestionRunResult> {
  const { uid, source } = input;

  // Nothing is pulled from a third party without a current, granted consent.
  const consent = await requireConsent(uid, "provider_ingest", source);

  const connection = await getConnection(uid, source);
  if (!connection) throw new ConnectionMissingError(source);

  const adapter = getActivitySource(source);
  const credentials = openCredentials(connection);

  const now = new Date();
  const lookbackDays = input.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const defaultStart = new Date(now.valueOf() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  // Resume from the stored cursor, but never look back less than the requested
  // window: that overlap is what makes missed webhooks self-healing.
  const cursorStart = connection.cursor?.since;
  const windowStart =
    cursorStart && new Date(cursorStart).valueOf() < new Date(defaultStart).valueOf()
      ? cursorStart
      : defaultStart;
  const windowEnd = now.toISOString();

  const page = await adapter.listActivitiesSince(credentials, {
    since: windowStart,
    until: windowEnd,
  });

  const wanted = input.onlySourceActivityIds?.length
    ? page.activities.filter((activity) =>
        input.onlySourceActivityIds!.includes(activity.sourceActivityId),
      )
    : page.activities;

  const known = input.force ? new Set<string>() : await knownSourceActivityIds(uid, source);
  // Loaded once per run, then reused for every duplicate check below.
  const candidates = await loadDedupeCandidates(uid);

  const result: IngestionRunResult = {
    source,
    scanned: page.activities.length,
    eligible: 0,
    imported: 0,
    updated: 0,
    duplicates: 0,
    skipped: [],
    failed: [],
    windowStart,
    windowEnd,
  };

  const maxDownloads = input.maxDownloads ?? 50;
  let downloads = 0;

  for (const summary of wanted) {
    // The sport policy runs BEFORE anything is downloaded: an out-of-scope
    // activity costs us one line in a list response and nothing else. A
    // treadmill run is never fetched, never parsed and never stored.
    const scope = decideSummaryScope(summary);
    if (!scope.ingest) {
      result.skipped.push({
        sourceActivityId: summary.sourceActivityId,
        reason: scope.detail ? `${scope.reason}:${scope.detail}` : scope.reason,
      });
      continue;
    }

    result.eligible += 1;

    if (known.has(summary.sourceActivityId)) {
      result.skipped.push({ sourceActivityId: summary.sourceActivityId, reason: "already_ingested" });
      continue;
    }

    if (downloads >= maxDownloads) {
      result.skipped.push({ sourceActivityId: summary.sourceActivityId, reason: "download_limit" });
      continue;
    }

    try {
      const file = await adapter.fetchActivityFile(credentials, summary.sourceActivityId);
      downloads += 1;

      if (!file) {
        result.skipped.push({ sourceActivityId: summary.sourceActivityId, reason: "no_file" });
        continue;
      }

      const normalized = adapter.normalize({ ownerUid: uid, summary, file });
      const outcome = await ingestActivity({ normalized, file, consentId: consent.id, candidates });
      recordOutcome(result, outcome.outcome, summary.sourceActivityId, outcome.reason);

      // Keep the in-memory view current so two duplicates inside one run are both
      // caught, not just the first.
      if (outcome.outcome === "created") {
        candidates.push({
          id: outcome.activityId,
          source,
          startedAt: normalized.startedAt,
          distanceMeters: Math.round(normalized.distanceMeters),
          startPoint: normalized.coordinates[0],
        });
      }
    } catch (error) {
      if (endsTheRun(error)) throw error;
      // Named, counted and reported — not swallowed. The run continues, and the
      // caller can see exactly which activity failed and why.
      result.failed.push({
        sourceActivityId: summary.sourceActivityId,
        code: ingestionErrorCode(error),
      });
      console.error("[ingestion] activity failed", {
        source,
        sourceActivityId: summary.sourceActivityId,
        error,
      });
    }
  }

  // Only advance the cursor on a full-window run. A webhook run looks at a
  // subset, so moving the cursor there could skip activities it never examined.
  // An activity that failed is left out of the cursor's promise by the trailing
  // overlap: the next run re-walks the same window and tries it again.
  if (!input.onlySourceActivityIds?.length) {
    await updateCursor(uid, source, page.nextCursor);
  }

  return result;
}

function recordOutcome(
  result: IngestionRunResult,
  outcome: IngestOutcome,
  sourceActivityId: string,
  reason?: string,
): void {
  switch (outcome) {
    case "created":
      result.imported += 1;
      break;
    case "updated":
      result.updated += 1;
      break;
    case "duplicate":
      result.duplicates += 1;
      break;
    default:
      result.skipped.push({ sourceActivityId, reason: reason ?? "skipped" });
  }
}

export class ConnectionMissingError extends Error {
  source: ActivitySourceId;

  constructor(source: ActivitySourceId) {
    super(`No ${source} connection for this user`);
    this.name = "ConnectionMissingError";
    this.source = source;
  }
}

/**
 * Structured diagnostics, following the Strava sync error-code pattern: the
 * client gets a specific machine-readable cause instead of a bare 500, and the
 * profile UI can tell the user what to actually do about it.
 */
export function ingestionErrorCode(error: unknown): string {
  if (error instanceof ConsentError) return error.code;
  if (error instanceof ConnectionMissingError) return "provider_not_connected";
  if (error instanceof TokenCryptoError) return "token_decrypt_failed";

  if (error instanceof IntervalsApiError) {
    if (error.message.includes("token exchange")) return "intervals_token_exchange_failed";
    if (error.status === 401 || error.status === 403) return "intervals_authorization_failed";
    if (error.status === 429) return "intervals_rate_limited";
    if (error.status >= 500) return "intervals_unavailable";
    return "intervals_api_failed";
  }

  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("INTERVALS_CLIENT_ID") || message.includes("INTERVALS_CLIENT_SECRET")) {
    return "intervals_env_missing";
  }
  if (message.includes("TOKEN_ENCRYPTION_KEY")) return "encryption_key_missing";
  // Firestore rejects an oversized document with an INVALID_ARGUMENT naming the
  // byte limit, and an over-indexed one by naming index entries. Both mean the
  // same thing to a user — that run's track was too big to store — and both used
  // to arrive as a bare `sync_failed`.
  if (
    /longer than \d+ bytes|maximum size|exceeds the maximum|too many index entries|index entries for entity/i.test(
      message,
    )
  ) {
    return "activity_too_large";
  }
  if (message.includes("FIREBASE") || message.includes("Firebase")) return "firebase_config_failed";
  return "sync_failed";
}

/** HTTP status that matches a diagnostic code. */
export function ingestionErrorStatus(code: string): number {
  switch (code) {
    case "consent_missing":
    case "consent_outdated":
      return 403;
    case "provider_not_connected":
      return 400;
    case "intervals_authorization_failed":
      return 401;
    case "intervals_rate_limited":
      return 429;
    case "intervals_unavailable":
      return 502;
    default:
      return 500;
  }
}
