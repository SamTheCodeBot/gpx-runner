import { NextRequest, NextResponse } from "next/server";
import { requireUid, UnauthorizedError } from "@/lib/ingestion/auth";
import { ingestionErrorCode, ingestionErrorStatus, runIngestion } from "@/lib/ingestion/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cursor-based reconciliation pull.
 *
 * This is the safety net behind the webhook, not the primary path: it re-walks
 * a trailing window so anything a webhook missed, dropped or never delivered
 * still lands. Because ingestion is idempotent on `(source, sourceActivityId)`
 * plus a content fingerprint, re-running it is free.
 *
 * `recent` covers the last 30 days; `backfill` covers a year for a first
 * connection. Both are bounded so one call cannot exhaust the provider's rate
 * limit.
 */

type SyncMode = "recent" | "backfill";

function syncOptions(mode: SyncMode): { lookbackDays: number; maxDownloads: number } {
  return mode === "backfill"
    ? { lookbackDays: 365, maxDownloads: 100 }
    : { lookbackDays: 30, maxDownloads: 30 };
}

export async function POST(req: NextRequest) {
  try {
    const uid = await requireUid(req);
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const mode: SyncMode = body?.mode === "backfill" ? "backfill" : "recent";
    const options = syncOptions(mode);

    const result = await runIngestion({
      uid,
      source: "intervals_icu",
      lookbackDays: options.lookbackDays,
      maxDownloads: options.maxDownloads,
      force: body?.force === true,
    });

    return NextResponse.json({ mode, ...result });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    const code = ingestionErrorCode(error);
    console.error("[intervals/sync]", { code, error });
    return NextResponse.json(
      { error: "Failed to sync intervals.icu activities", code },
      { status: ingestionErrorStatus(code) },
    );
  }
}
