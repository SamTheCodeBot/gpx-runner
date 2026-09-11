import { NextRequest, NextResponse } from "next/server";
import { intervalsAuthorizeUrl, INTERVALS_SCOPE } from "@/lib/intervals";
import { createOAuthState } from "@/lib/oauthState";
import { tokenEncryptionConfigured } from "@/lib/tokenCrypto";
import { requireUid, UnauthorizedError } from "@/lib/ingestion/auth";
import { consentText, recordConsent } from "@/lib/ingestion/consent";
import { getConnection, publicConnectionView, saveConnection } from "@/lib/ingestion/connections";
import { getActivitySource } from "@/lib/ingestion/registry";
import { ingestionErrorCode, ingestionErrorStatus } from "@/lib/ingestion/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start an intervals.icu connection.
 *
 * GDPR: consent is captured *before* the authorisation flow begins, never after
 * data has arrived. The client must GET this route to obtain the current
 * consent text, show it, and then POST back the exact version the user agreed
 * to. A version mismatch is rejected, so a stale UI cannot record agreement to
 * wording the user never saw.
 */

function stateSecret(): string {
  const secret = process.env.INTERVALS_CLIENT_SECRET || process.env.TOKEN_ENCRYPTION_KEY;
  if (!secret) throw new Error("Missing env var: INTERVALS_CLIENT_SECRET");
  return secret;
}

export async function GET(req: NextRequest) {
  try {
    const uid = await requireUid(req);
    const connection = await getConnection(uid, "intervals_icu");
    const consent = consentText("provider_ingest", "intervals_icu");

    return NextResponse.json({
      consent: { version: consent.version, text: consent.text },
      scope: INTERVALS_SCOPE,
      connection: connection ? publicConnectionView(connection) : null,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    console.error("[intervals/connect] GET", error);
    return NextResponse.json({ error: "Failed to load connection state" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const uid = await requireUid(req);

    if (!tokenEncryptionConfigured()) {
      // Fail closed rather than store a provider credential in the clear.
      return NextResponse.json(
        { error: "Server is not configured to store provider tokens", code: "encryption_key_missing" },
        { status: 500 },
      );
    }

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const mode = body?.mode === "api_key" ? "api_key" : "oauth";
    const current = consentText("provider_ingest", "intervals_icu");

    if (body?.consentVersion !== current.version) {
      return NextResponse.json(
        {
          error: "Consent must be given against the current consent text",
          code: "consent_version_mismatch",
          consent: { version: current.version, text: current.text },
        },
        { status: 409 },
      );
    }

    // Recorded before a single byte is requested from intervals.icu.
    const consent = await recordConsent({
      uid,
      purpose: "provider_ingest",
      source: "intervals_icu",
      granted: true,
    });

    if (mode === "api_key") {
      const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
      if (!apiKey) {
        return NextResponse.json({ error: "Missing intervals.icu API key" }, { status: 400 });
      }

      // Validates the key against the provider before anything is stored.
      const result = await getActivitySource("intervals_icu").connect({ apiKey });
      const connection = await saveConnection({
        uid,
        source: "intervals_icu",
        result,
        authMode: "api_key",
        consentId: consent.id,
      });

      return NextResponse.json({ mode, connection: publicConnectionView(connection) });
    }

    const redirectUri = `${req.nextUrl.origin}/api/intervals/callback`;
    const url = intervalsAuthorizeUrl({
      redirectUri,
      state: createOAuthState(uid, { secret: stateSecret(), provider: "intervals_icu" }),
    });

    return NextResponse.json({ mode, url });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    const code = ingestionErrorCode(error);
    console.error("[intervals/connect]", { code, error });
    return NextResponse.json(
      { error: "Failed to start intervals.icu connection", code },
      { status: ingestionErrorStatus(code) },
    );
  }
}
