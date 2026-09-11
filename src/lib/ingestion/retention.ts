import type { RetentionPolicyId, RetentionStamp } from "@/app/types";

/**
 * Storage limitation (GDPR Art. 5(1)(e)): personal data may be kept only as
 * long as it is needed for the purpose it was collected for. Retention is a
 * property of every stored record rather than a cleanup script's private
 * opinion, so `stampRetention` is called on write and the expiry travels with
 * the data.
 *
 * Durations are configurable so the operator can tighten them without a code
 * change. Defaults are deliberately short for anything that is not the user's
 * actual training history.
 */

function envDays(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function retentionDays(policy: RetentionPolicyId): number | null {
  switch (policy) {
    case "activity_user_lifetime":
      // The user's own training history. Kept until they delete it or close
      // the account, which is what they signed up for, so no fixed expiry.
      return null;
    case "raw_payload_short":
      // Original provider files are kept only long enough to re-parse after a
      // parser bug. They are a copy of data we already hold canonically.
      return envDays("RAW_PAYLOAD_RETENTION_DAYS", 30);
    case "consent_evidence":
      // Proof of consent under Art. 7(1). Outlives the consent itself so the
      // controller can still demonstrate what was agreed and when.
      return envDays("CONSENT_RETENTION_DAYS", 365 * 3);
    case "sync_audit":
      // Sync and webhook audit lines: operational troubleshooting only.
      return envDays("SYNC_AUDIT_RETENTION_DAYS", 90);
    default:
      return envDays("DEFAULT_RETENTION_DAYS", 90);
  }
}

export function stampRetention(policy: RetentionPolicyId, from: Date = new Date()): RetentionStamp {
  const days = retentionDays(policy);
  if (days === null) return { policy };

  const expires = new Date(from.valueOf() + days * 24 * 60 * 60 * 1000);
  return { policy, expiresAt: expires.toISOString() };
}

export function isExpired(stamp: RetentionStamp | undefined, now: Date = new Date()): boolean {
  if (!stamp?.expiresAt) return false;
  return new Date(stamp.expiresAt).valueOf() <= now.valueOf();
}

/** Human-readable summary used by docs/gdpr.md and the export endpoint. */
export function retentionSummary(): Record<RetentionPolicyId, string> {
  const describe = (policy: RetentionPolicyId) => {
    const days = retentionDays(policy);
    return days === null ? "until the user deletes it or erases their account" : `${days} days`;
  };

  return {
    activity_user_lifetime: describe("activity_user_lifetime"),
    raw_payload_short: describe("raw_payload_short"),
    consent_evidence: describe("consent_evidence"),
    sync_audit: describe("sync_audit"),
  };
}
