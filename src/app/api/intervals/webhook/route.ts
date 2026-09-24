import { createHash, createHmac } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { secretsMatch } from "@/lib/tokenCrypto";
import { FIRESTORE_QUOTA_CODE } from "@/lib/firestoreQuota";
import { findConnectionByExternalId } from "@/lib/ingestion/connections";
import { stampRetention } from "@/lib/ingestion/retention";
import { ingestionErrorCode, runIngestion } from "@/lib/ingestion/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * intervals.icu push ingest.
 *
 * VERIFICATION CAVEAT: the webhook callback URL and shared secret are
 * configured on the provider's "Manage App" page, but the delivery format \u2014 the
 * signature header name, the signing scheme and the JSON body shape \u2014 is not
 * published in the OpenAPI document or the public forum guides. Rather than
 * invent a specific contract, this handler:
 *
 *   - accepts either an HMAC-SHA256 signature over the raw body or a plain
 *     shared-secret header, with both header names configurable by env;
 *   - parses athlete and activity ids leniently from several plausible field
 *     names, and falls back to a plain window pull when it recognises nothing;
 *   - treats every delivery as a hint only. Nothing is trusted from the body
 *     except which athlete to look at; the activity data itself is always
 *     re-fetched from the API.
 *
 * Confirm the real format against a live delivery and tighten `parseDelivery`
 * and the header names. Until then the reconciliation pull is the source of
 * truth and this route is pure latency improvement.
 */

const DELIVERY_COLLECTION = "webhookDeliveries";

function signatureHeaderName(): string {
  return (process.env.INTERVALS_WEBHOOK_SIGNATURE_HEADER || "x-intervals-signature").toLowerCase();
}

function secretHeaderName(): string {
  return (process.env.INTERVALS_WEBHOOK_SECRET_HEADER || "x-webhook-secret").toLowerCase();
}

/**
 * Fails closed: with no configured secret the endpoint refuses every delivery,
 * so an unconfigured deployment cannot be fed arbitrary data by anyone who
 * guesses the URL.
 */
function verifyDelivery(req: NextRequest, rawBody: string): boolean {
  const secret = process.env.INTERVALS_WEBHOOK_SECRET;
  if (!secret) return false;

  const provided = req.headers.get(secretHeaderName());
  if (provided && secretsMatch(provided, secret)) return true;

  const signature = req.headers.get(signatureHeaderName());
  if (!signature) return false;

  const digest = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const candidates = [
    digest.toString("hex"),
    digest.toString("base64"),
    `sha256=${digest.toString("hex")}`,
  ];

  return candidates.some((candidate) => secretsMatch(signature, candidate));
}

type Delivery = {
  athleteId?: string;
  activityIds: string[];
};

/** Lenient extraction; see the caveat above. */
function parseDelivery(payload: unknown): Delivery {
  const activityIds = new Set<string>();
  let athleteId: string | undefined;

  const visit = (node: unknown, depth: number): void => {
    if (depth > 4 || !node || typeof node !== "object") return;

    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, depth + 1));
      return;
    }

    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const normalizedKey = key.toLowerCase();

      if (!athleteId && /^(athlete_id|athleteid|icu_athlete_id|owner_id)$/.test(normalizedKey)) {
        if (typeof value === "string" || typeof value === "number") athleteId = String(value);
      }
      if (/^(activity_id|activityid|object_id|id)$/.test(normalizedKey)) {
        if (typeof value === "string" || typeof value === "number") activityIds.add(String(value));
      }
      if (normalizedKey === "athlete" && value && typeof value === "object") {
        const nested = (value as Record<string, unknown>).id;
        if (!athleteId && (typeof nested === "string" || typeof nested === "number")) {
          athleteId = String(nested);
        }
      }

      visit(value, depth + 1);
    }
  };

  visit(payload, 0);
  return { athleteId, activityIds: [...activityIds] };
}

/**
 * Idempotency: providers retry, and a retry must not re-ingest. The delivery id
 * is the provider's own if it sends one, otherwise a hash of the raw body.
 */
async function claimDelivery(deliveryId: string): Promise<boolean> {
  const ref = adminDb().collection(DELIVERY_COLLECTION).doc(deliveryId);

  try {
    await ref.create({
      id: deliveryId,
      source: "intervals_icu",
      receivedAt: new Date().toISOString(),
      retention: stampRetention("sync_audit"),
    });
    return true;
  } catch {
    // `create` fails when the document already exists: a duplicate delivery.
    return false;
  }
}

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();

    if (!verifyDelivery(req, rawBody)) {
      return NextResponse.json({ error: "Invalid webhook signature" }, { status: 401 });
    }

    const deliveryId =
      req.headers.get("x-delivery-id") ??
      req.headers.get("x-request-id") ??
      createHash("sha256").update(rawBody).digest("hex").slice(0, 40);

    if (!(await claimDelivery(deliveryId))) {
      // Already handled. Acknowledge so the provider stops retrying.
      return NextResponse.json({ ok: true, duplicate: true });
    }

    const payload = rawBody ? JSON.parse(rawBody) : {};
    const delivery = parseDelivery(payload);

    if (!delivery.athleteId) {
      console.warn("[intervals/webhook] delivery without a recognisable athlete id");
      return NextResponse.json({ ok: true, ignored: "no_athlete_id" });
    }

    const connection = await findConnectionByExternalId("intervals_icu", delivery.athleteId);
    if (!connection) {
      // Not our user, or they disconnected. Acknowledge and drop.
      return NextResponse.json({ ok: true, ignored: "no_connection" });
    }

    const result = await runIngestion({
      uid: connection.uid,
      source: "intervals_icu",
      // Short window: the webhook says something just happened.
      lookbackDays: 7,
      maxDownloads: 5,
      onlySourceActivityIds: delivery.activityIds.length ? delivery.activityIds : undefined,
    });

    await adminDb()
      .collection(DELIVERY_COLLECTION)
      .doc(deliveryId)
      .set({ processedAt: new Date().toISOString(), imported: result.imported }, { merge: true });

    return NextResponse.json({ ok: true, imported: result.imported });
  } catch (error) {
    const code = ingestionErrorCode(error);
    console.error("[intervals/webhook]", { code, error });

    // Asking the provider to retry is only useful when a retry could succeed.
    // A spent daily budget or a spent database quota will still be spent in
    // five minutes, and every retry costs another delivery, another lookup and
    // another sync attempt — a retry storm on top of whatever caused the ceiling
    // to be reached. Acknowledge instead: the reconciliation pull is the source
    // of truth here, and it will collect these activities on its next run.
    if (code === "daily_budget_exhausted" || code === FIRESTORE_QUOTA_CODE) {
      return NextResponse.json({ ok: true, deferred: code });
    }

    // 500 so the provider retries; the delivery record makes that safe.
    return NextResponse.json({ error: "Failed to handle webhook", code }, { status: 500 });
  }
}

/**
 * Some providers verify a callback URL with a GET challenge before enabling
 * deliveries. This is not documented for intervals.icu; it is here because it
 * is harmless and unblocks setup if they do. Requires the shared secret.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.INTERVALS_WEBHOOK_SECRET;
  const provided = req.headers.get(secretHeaderName()) ?? req.nextUrl.searchParams.get("secret");

  if (!secret || !provided || !secretsMatch(provided, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const challenge =
    req.nextUrl.searchParams.get("challenge") ?? req.nextUrl.searchParams.get("hub.challenge");

  return NextResponse.json(challenge ? { challenge } : { ok: true });
}
