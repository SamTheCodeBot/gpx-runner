import { NextRequest, NextResponse } from "next/server";
import { verifyOAuthState } from "@/lib/oauthState";
import { getConsent } from "@/lib/ingestion/consent";
import { saveConnection } from "@/lib/ingestion/connections";
import { getActivitySource } from "@/lib/ingestion/registry";
import { ingestionErrorCode } from "@/lib/ingestion/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * intervals.icu OAuth callback.
 *
 * Per the provider's OAuth guide the redirect carries `code` and our `state`,
 * or `error=access_denied` when the user declines. The state is HMAC-verified
 * and provider-scoped, so a state minted for another provider cannot be
 * replayed here.
 */

function stateSecret(): string {
  const secret = process.env.INTERVALS_CLIENT_SECRET || process.env.TOKEN_ENCRYPTION_KEY;
  if (!secret) throw new Error("Missing env var: INTERVALS_CLIENT_SECRET");
  return secret;
}

export async function GET(req: NextRequest) {
  const redirectBase = req.nextUrl.origin;

  try {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get("code");
    const state = searchParams.get("state") ?? "";
    const error = searchParams.get("error");

    if (error) {
      return NextResponse.redirect(`${redirectBase}/profile?intervals=denied`);
    }
    if (!code || !state) {
      return NextResponse.redirect(`${redirectBase}/profile?intervals=error`);
    }

    const { uid } = verifyOAuthState(state, {
      secret: stateSecret(),
      provider: "intervals_icu",
    });

    // Consent was recorded before the flow started; re-check it here so a
    // hand-crafted callback cannot create a connection without one.
    const consent = await getConsent(uid, "provider_ingest", "intervals_icu");
    if (!consent?.granted) {
      return NextResponse.redirect(`${redirectBase}/profile?intervals=consent`);
    }

    const result = await getActivitySource("intervals_icu").connect({ code });
    await saveConnection({
      uid,
      source: "intervals_icu",
      result,
      authMode: "oauth",
      consentId: consent.id,
    });

    return NextResponse.redirect(`${redirectBase}/profile?intervals=connected`);
  } catch (error) {
    // Never echo the code or token into logs.
    console.error("[intervals/callback]", { code: ingestionErrorCode(error), error });
    return NextResponse.redirect(`${redirectBase}/profile?intervals=error`);
  }
}
