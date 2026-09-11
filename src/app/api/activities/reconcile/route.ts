import { NextRequest, NextResponse } from "next/server";
import { requireUid, UnauthorizedError } from "@/lib/ingestion/auth";
import {
  ReconcileLimitError,
  reconcileActivityScope,
  type ReconcileInput,
} from "@/lib/ingestion/reconcile";
import { ingestionErrorCode, ingestionErrorStatus } from "@/lib/ingestion/sync";
import type { ActivitySourceId } from "@/app/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Bring already-ingested activities in line with the current sport policy.
 *
 * This is the cleanup for treadmill runs that were ingested before the policy
 * existed. It is a deliberate, user-initiated action and never part of a sync:
 *
 *   POST /api/activities/reconcile                      \u2192 dry run, lists only
 *   POST /api/activities/reconcile {"dryRun": false}    \u2192 actually deletes
 *
 * Only the caller's own data is ever touched, and only records the ingestion
 * spine created. A manually uploaded GPX route has no canonical activity and is
 * invisible to this endpoint.
 */
export async function POST(req: NextRequest) {
  try {
    const uid = await requireUid(req);
    const body = (await req.json().catch(() => ({}))) as Partial<ReconcileInput>;

    const report = await reconcileActivityScope({
      uid,
      // Destructive only on an explicit `false`. A malformed body is a dry run.
      dryRun: body?.dryRun !== false,
      source: typeof body?.source === "string" ? (body.source as ActivitySourceId) : undefined,
    });

    return NextResponse.json(report);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof ReconcileLimitError) {
      return NextResponse.json(
        { error: error.message, code: "reconcile_limit_exceeded" },
        { status: 409 },
      );
    }
    const code = ingestionErrorCode(error);
    console.error("[activities/reconcile]", { code, error });
    return NextResponse.json(
      { error: "Failed to reconcile activities", code },
      { status: ingestionErrorStatus(code) },
    );
  }
}
