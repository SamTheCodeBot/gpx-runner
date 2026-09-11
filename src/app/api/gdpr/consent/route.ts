import { NextRequest, NextResponse } from "next/server";
import { requireUid, UnauthorizedError } from "@/lib/ingestion/auth";
import {
  CONSENT_TEXTS,
  ConsentError,
  consentText,
  listConsents,
  recordConsent,
  withdrawConsent,
} from "@/lib/ingestion/consent";
import { isKnownSource } from "@/lib/ingestion/registry";
import type { ActivitySourceId, ConsentPurpose } from "@/app/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Consent management (GDPR Art. 7).
 *
 * GET  returns the current wording for every purpose alongside what this user
 *      has actually agreed to, so the UI can show "you agreed to X on date Y"
 *      and detect when wording has moved on and re-consent is needed.
 * POST grants or withdraws one purpose. Withdrawal takes the same single call
 *      as granting, which is the Art. 7(3) requirement in practice.
 */

const PURPOSES: ConsentPurpose[] = ["provider_ingest", "club_sharing", "public_sharing"];

export async function GET(req: NextRequest) {
  try {
    const uid = await requireUid(req);
    const records = await listConsents(uid);

    return NextResponse.json({
      available: Object.entries(CONSENT_TEXTS).map(([key, value]) => ({
        key,
        version: value.version,
        text: value.text,
      })),
      granted: records,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    console.error("[gdpr/consent] GET", error);
    return NextResponse.json({ error: "Failed to load consent state" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const uid = await requireUid(req);
    const body = await req.json().catch(() => ({} as Record<string, unknown>));

    const purpose = body?.purpose as ConsentPurpose;
    if (!PURPOSES.includes(purpose)) {
      return NextResponse.json({ error: "Unknown consent purpose" }, { status: 400 });
    }

    const rawSource = typeof body?.source === "string" ? body.source : undefined;
    if (rawSource && !isKnownSource(rawSource)) {
      return NextResponse.json({ error: "Unknown source" }, { status: 400 });
    }
    const source = rawSource as ActivitySourceId | undefined;

    if (body?.granted === false) {
      await withdrawConsent({ uid, purpose, source });
      return NextResponse.json({ ok: true, granted: false });
    }

    // Granting requires echoing back the current version, so consent is always
    // tied to wording the user was actually shown.
    const current = consentText(purpose, source);
    if (body?.version !== current.version) {
      return NextResponse.json(
        {
          error: "Consent must be given against the current consent text",
          code: "consent_version_mismatch",
          consent: { version: current.version, text: current.text },
        },
        { status: 409 },
      );
    }

    const record = await recordConsent({ uid, purpose, source, granted: true });
    return NextResponse.json({ ok: true, consent: record });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof ConsentError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    }
    console.error("[gdpr/consent]", error);
    return NextResponse.json({ error: "Failed to record consent" }, { status: 500 });
  }
}
