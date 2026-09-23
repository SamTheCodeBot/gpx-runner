import { NextRequest, NextResponse } from "next/server";
import { requireUid, UnauthorizedError } from "@/lib/ingestion/auth";
import {
  loadHistoryProgress,
  runHistoryBatch,
  HISTORY_MAX_DOWNLOADS,
} from "@/lib/ingestion/history";
import { ingestionErrorCode, ingestionErrorStatus } from "@/lib/ingestion/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Full-history import: one bounded batch per call, resumable across calls.
 *
 * `GET`  reports stored progress, so a reloaded tab picks up the import that
 *        was already running instead of offering to start a new one.
 * `POST` runs the next batch and returns the updated progress. The client
 *        repeats it until `progress.status` is `done`.
 *
 * The per-call ceiling stays in force here exactly as it does on the
 * reconciliation pull — it is simply no longer the end of the road, because the
 * frontier is written down. intervals.icu and Garmin impose no limit on how far
 * back history may be read; the ceiling is ours, so that one request cannot
 * exhaust the provider.
 *
 * intervals.icu only. Strava has no adapter in the ingestion registry and is
 * not reachable from this route.
 */
export async function GET(req: NextRequest) {
  try {
    const uid = await requireUid(req);
    const progress = await loadHistoryProgress(uid, "intervals_icu");
    return NextResponse.json({ progress });
  } catch (error) {
    return errorResponse(error, "GET");
  }
}

export async function POST(req: NextRequest) {
  try {
    const uid = await requireUid(req);
    const body = await req.json().catch(() => ({}) as Record<string, unknown>);

    const requested = Number(body?.maxDownloads);
    const result = await runHistoryBatch({
      uid,
      source: "intervals_icu",
      restart: body?.restart === true,
      maxDownloads: Number.isFinite(requested) ? requested : HISTORY_MAX_DOWNLOADS,
      // Opt-in. Keeping every original GPX for a fifteen-year history is about
      // a gigabyte of Firestore writes for files that expire in thirty days.
      retainRawPayload: body?.retainRawPayload === true,
    });

    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, "POST");
  }
}

function errorResponse(error: unknown, method: string) {
  if (error instanceof UnauthorizedError) {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }
  const code = ingestionErrorCode(error);
  // The code is a fixed vocabulary from `ingestionErrorCode`; the provider's
  // body and our credentials never travel to the browser.
  console.error("[intervals/history]", { method, code });
  return NextResponse.json(
    { error: "The history import batch did not finish", code },
    { status: ingestionErrorStatus(code) },
  );
}
