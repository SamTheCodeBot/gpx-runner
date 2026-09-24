/**
 * Recognising a spent Firestore quota.
 *
 * On the Spark plan Firestore stops serving once the day's free allowance is
 * gone — 50,000 document reads, 20,000 writes — and every call after that,
 * read or write, comes back as gRPC status 8 `RESOURCE_EXHAUSTED` with the
 * message "Quota exceeded.". The allowance resets at midnight America/Los_Angeles.
 *
 * Untreated, that surfaces as a bare `http_500` with no clue in it. On
 * 2026-09-23 a full-history import spent the day's reads and took the entire
 * app down with it; the profile page said "Failed to load connection state"
 * and half an hour went into proving that neither the code nor the deployment
 * was at fault. The cause is knowable from the error object, so it should be
 * said out loud instead of rediscovered.
 *
 * Detection accepts the several shapes `firebase-admin` uses — the numeric gRPC
 * code on some paths, a string status on others, a message on the rest — but it
 * always requires an actual RESOURCE_EXHAUSTED signal.
 *
 * A bare HTTP 429 is deliberately NOT enough. intervals.icu rate-limiting us is
 * also a 429, and the two need opposite advice: one is fixed by waiting a few
 * minutes, the other cannot be fixed by retrying at all. Telling them apart on
 * the status code alone got `intervals_rate_limited` misfiled the first time
 * this was written, and the test suite caught it.
 */

/** gRPC status code for RESOURCE_EXHAUSTED. */
const GRPC_RESOURCE_EXHAUSTED = 8;

export const FIRESTORE_QUOTA_CODE = "firestore_quota_exhausted";

export function isQuotaExhausted(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const candidate = error as { code?: unknown; status?: unknown; message?: unknown };

  if (candidate.code === GRPC_RESOURCE_EXHAUSTED) return true;
  if (candidate.code === "RESOURCE_EXHAUSTED" || candidate.status === "RESOURCE_EXHAUSTED") {
    return true;
  }

  const message = typeof candidate.message === "string" ? candidate.message : "";
  return /RESOURCE_EXHAUSTED|Quota exceeded/i.test(message);
}

/**
 * When the free allowance comes back, in the reader's own clock.
 *
 * Firestore's daily quota rolls over at midnight Pacific, which is a fact no
 * user should have to look up while staring at a broken page.
 */
export function quotaResetsAt(now: Date = new Date()): Date {
  // Pacific is UTC-8, or UTC-7 while daylight saving is in force. Rather than
  // pull in a timezone database for one boundary, read the offset back out of
  // the formatter the runtime already has.
  const pacific = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const offsetMs = now.valueOf() - pacific.valueOf();

  const nextMidnightPacific = new Date(pacific);
  nextMidnightPacific.setHours(24, 0, 0, 0);

  return new Date(nextMidnightPacific.valueOf() + offsetMs);
}
