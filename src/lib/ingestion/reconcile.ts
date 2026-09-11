import { adminDb } from "@/lib/firebaseAdmin";
import { decideStoredActivityScope, describeScopeRejection, type ScopeRejectionReason } from "./sportPolicy";
import { ACTIVITY_COLLECTION, RAW_PAYLOAD_COLLECTION, ROUTE_COLLECTION } from "./store";
import type { ActivitySourceId, CanonicalActivity } from "@/app/types";

/**
 * Reconcile already-ingested activities against the current sport policy.
 *
 * The sport policy stops new treadmill runs at the door. It does nothing about
 * the ones ingested before it existed \u2014 and those are sitting in the owner's
 * map, heatmap and badges right now. This is the cleanup.
 *
 * Three deliberate constraints:
 *
 *   1. It is NEVER run at import time. Mass deletion is an explicit, separate
 *      action a human asks for; a sync job that quietly deletes history is a
 *      bug waiting to destroy data.
 *   2. It defaults to a DRY RUN. The caller gets the full list of what would be
 *      removed and why, and has to come back with `dryRun: false` to act.
 *   3. It only considers records the ingestion spine created, i.e. documents in
 *      the `activities` collection. Manually uploaded GPX routes have no
 *      canonical activity and are never examined, never mind deleted.
 *
 * Removing one out-of-scope activity means removing all three of its artefacts:
 * the canonical record, the geometry in `routes`, and any retained raw payload.
 * Leaving the route behind is what would orphan a treadmill run in the UI with
 * nothing left to explain where it came from.
 */

export type ReconcileCandidate = {
  activityId: string;
  name: string;
  startedAt: string;
  source: ActivitySourceId;
  sport: string;
  sourceSport?: string;
  distanceMeters: number;
  reason: ScopeRejectionReason;
  /** Human-readable version of `reason`, for the confirmation prompt. */
  explanation: string;
  routeId?: string;
};

export type ReconcileReport = {
  dryRun: boolean;
  scanned: number;
  outOfScope: ReconcileCandidate[];
  deleted: { activities: number; routes: number; rawPayloads: number };
};

export type ReconcileInput = {
  uid: string;
  /** Defaults to true. Nothing is deleted unless this is explicitly false. */
  dryRun?: boolean;
  /** Restrict to one provider; omit to check every ingested activity. */
  source?: ActivitySourceId;
  /** Safety rail: refuse to delete more than this in one pass. */
  maxDeletions?: number;
};

export class ReconcileLimitError extends Error {
  constructor(count: number, limit: number) {
    super(`Refusing to delete ${count} activities in one pass (limit ${limit})`);
    this.name = "ReconcileLimitError";
  }
}

const DEFAULT_MAX_DELETIONS = 500;

export async function reconcileActivityScope(input: ReconcileInput): Promise<ReconcileReport> {
  const { uid } = input;
  const dryRun = input.dryRun !== false;
  const maxDeletions = input.maxDeletions ?? DEFAULT_MAX_DELETIONS;
  const db = adminDb();

  // Single equality filter plus an optional source filter; both are served by
  // automatic single-field indexes, so this needs no composite index deployed.
  let query = db.collection(ACTIVITY_COLLECTION).where("ownerUid", "==", uid);
  if (input.source) query = query.where("source", "==", input.source);

  const snap = await query.get();
  const outOfScope: ReconcileCandidate[] = [];

  snap.forEach((doc) => {
    const activity = doc.data() as CanonicalActivity;
    // Duplicate stubs carry no track and no sport; they are bookkeeping, not
    // app-visible activities, so the policy has nothing to say about them.
    if (activity.duplicateOf) return;

    const decision = decideStoredActivityScope(activity);
    if (decision.ingest) return;

    outOfScope.push({
      activityId: doc.id,
      name: activity.name ?? "Untitled activity",
      startedAt: activity.startedAt ?? "",
      source: activity.source,
      sport: activity.sport,
      sourceSport: activity.sourceSport,
      distanceMeters: activity.distanceMeters ?? 0,
      reason: decision.reason,
      explanation: describeScopeRejection(decision.reason, decision.detail),
      routeId: activity.trackRef?.id,
    });
  });

  outOfScope.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  const report: ReconcileReport = {
    dryRun,
    scanned: snap.size,
    outOfScope,
    deleted: { activities: 0, routes: 0, rawPayloads: 0 },
  };

  if (dryRun || outOfScope.length === 0) return report;

  if (outOfScope.length > maxDeletions) {
    throw new ReconcileLimitError(outOfScope.length, maxDeletions);
  }

  // Chunked well inside Firestore's 500-writes-per-batch cap, counting three
  // possible deletes per activity.
  const chunkSize = 100;
  for (let i = 0; i < outOfScope.length; i += chunkSize) {
    const chunk = outOfScope.slice(i, i + chunkSize);

    // Raw payloads are optional (large tracks and `STORE_RAW_PAYLOADS=false`
    // skip them), so check which exist rather than reporting deletions that
    // never happened. `delete` on a missing document succeeds silently.
    const payloadRefs = chunk.map((candidate) =>
      db.collection(RAW_PAYLOAD_COLLECTION).doc(candidate.activityId.replace(/[^\w.-]/g, "_")),
    );
    const payloads = payloadRefs.length ? await db.getAll(...payloadRefs) : [];

    const batch = db.batch();

    for (const candidate of chunk) {
      batch.delete(db.collection(ACTIVITY_COLLECTION).doc(candidate.activityId));
      report.deleted.activities += 1;

      if (candidate.routeId) {
        batch.delete(db.collection(ROUTE_COLLECTION).doc(candidate.routeId));
        report.deleted.routes += 1;
      }
    }

    payloads.forEach((payload) => {
      if (!payload.exists) return;
      batch.delete(payload.ref);
      report.deleted.rawPayloads += 1;
    });

    await batch.commit();
  }

  return report;
}
