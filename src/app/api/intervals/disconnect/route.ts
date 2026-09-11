import { NextRequest, NextResponse } from "next/server";
import { requireUid, UnauthorizedError } from "@/lib/ingestion/auth";
import { withdrawConsent } from "@/lib/ingestion/consent";
import { deleteConnection, getConnection, openCredentials } from "@/lib/ingestion/connections";
import { getActivitySource } from "@/lib/ingestion/registry";
import { ingestionErrorCode, ingestionErrorStatus } from "@/lib/ingestion/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Disconnect intervals.icu.
 *
 * Withdrawing consent must be as easy as giving it (Art. 7(3)), so this route
 * does three things in order: revoke upstream at the provider, drop the stored
 * credentials, and mark the consent withdrawn.
 *
 * Disconnecting deliberately does NOT delete already-ingested activities \u2014 they
 * are the user's own training history and deleting them silently would be the
 * surprising choice. `/api/gdpr/erase` is the route that deletes data, and the
 * UI should offer both.
 */
export async function POST(req: NextRequest) {
  try {
    const uid = await requireUid(req);
    const connection = await getConnection(uid, "intervals_icu");

    if (connection) {
      try {
        await getActivitySource("intervals_icu").disconnect(openCredentials(connection));
      } catch (error) {
        // Losing the upstream revoke must not strand the local connection.
        console.warn("[intervals/disconnect] upstream revoke failed; removing local connection", {
          code: ingestionErrorCode(error),
        });
      }
      await deleteConnection(uid, "intervals_icu");
    }

    await withdrawConsent({ uid, purpose: "provider_ingest", source: "intervals_icu" });

    return NextResponse.json({ ok: true, activitiesRetained: true });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    const code = ingestionErrorCode(error);
    console.error("[intervals/disconnect]", { code, error });
    return NextResponse.json(
      { error: "Failed to disconnect intervals.icu", code },
      { status: ingestionErrorStatus(code) },
    );
  }
}
