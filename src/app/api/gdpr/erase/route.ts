import { NextRequest, NextResponse } from "next/server";
import { requireUid, UnauthorizedError } from "@/lib/ingestion/auth";
import { eraseUserData, type ErasureScope } from "@/lib/ingestion/erasure";
import { isKnownSource } from "@/lib/ingestion/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Right to erasure (GDPR Art. 17).
 *
 * Hard delete, not a flag. Two scopes:
 *   `account`        everything we hold about the caller
 *   `<source id>`    only what one adapter ingested, e.g. `intervals_icu`
 *
 * The caller must send the literal confirmation string. That is the
 * written-confirmation step: an accidental POST, a mis-wired button or a replayed
 * request cannot destroy someone's training history. The response is a receipt
 * the user can keep, stating what was deleted and when.
 */

const CONFIRMATION_PHRASE = "DELETE MY DATA";

export async function POST(req: NextRequest) {
  try {
    const uid = await requireUid(req);
    const body = await req.json().catch(() => ({} as Record<string, unknown>));

    if (body?.confirm !== CONFIRMATION_PHRASE) {
      return NextResponse.json(
        {
          error: "Erasure requires explicit written confirmation",
          code: "confirmation_required",
          required: { field: "confirm", value: CONFIRMATION_PHRASE },
        },
        { status: 400 },
      );
    }

    const requestedScope = typeof body?.scope === "string" ? body.scope : "account";
    if (requestedScope !== "account" && !isKnownSource(requestedScope)) {
      return NextResponse.json(
        { error: "Unknown erasure scope", code: "unknown_scope" },
        { status: 400 },
      );
    }

    const receipt = await eraseUserData({ uid, scope: requestedScope as ErasureScope });

    return NextResponse.json(receipt, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    console.error("[gdpr/erase]", error);
    return NextResponse.json({ error: "Failed to erase data" }, { status: 500 });
  }
}
