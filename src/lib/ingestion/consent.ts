import { randomUUID } from "crypto";
import { adminDb } from "@/lib/firebaseAdmin";
import { stampRetention } from "./retention";
import type { ActivitySourceId, ConsentPurpose, ConsentRecord } from "@/app/types";

/**
 * Consent capture and enforcement.
 *
 * GDPR Art. 4(11) and Art. 7: consent must be specific, informed, unambiguous
 * and demonstrable. A boolean flag proves nothing, so every grant stores the
 * exact wording shown to the user, the version of that wording, and the
 * timestamp. Withdrawal (Art. 7(3)) marks the record rather than deleting it,
 * so the audit trail of what was agreed remains intact.
 *
 * `requireConsent` is called before any third-party pull. There is no code path
 * that ingests provider data without passing through it.
 */

export const CONSENT_COLLECTION = "consentRecords";

/**
 * Versioned consent wording. Bump the version whenever a single word changes:
 * an old grant must never be silently reinterpreted as agreement to new text.
 */
export const CONSENT_TEXTS: Record<string, { version: string; text: string }> = {
  "provider_ingest:intervals_icu": {
    version: "2026-09-11.1",
    text:
      "I allow GPX Runner to connect to my intervals.icu account and download my " +
      "running activities: the GPS track, start time, distance, duration, elevation " +
      "and activity name. GPX Runner will not download heart rate, sleep, HRV or " +
      "other health metrics. My activities stay private to me unless I choose to " +
      "share them. I can disconnect at any time, and disconnecting revokes GPX " +
      "Runner's access at intervals.icu.",
  },
  club_sharing: {
    version: "2026-09-11.1",
    text:
      "I allow GPX Runner to show the routes I explicitly share with a run club to " +
      "the other members of that club. This applies only to routes I choose to " +
      "share; everything else stays private. I can stop sharing at any time.",
  },
  public_sharing: {
    version: "2026-09-11.1",
    text:
      "I allow GPX Runner to show the routes I explicitly make public on public club " +
      "pages, visible to anyone with the link. I understand a GPS track can reveal " +
      "where I live or work. I can make a route private again at any time.",
  },
};

export function consentKey(purpose: ConsentPurpose, source?: ActivitySourceId): string {
  return source ? `${purpose}:${source}` : purpose;
}

/** The wording to present for a purpose. Throws if a purpose has no text yet. */
export function consentText(purpose: ConsentPurpose, source?: ActivitySourceId) {
  const entry = CONSENT_TEXTS[consentKey(purpose, source)];
  if (!entry) throw new ConsentError(`No consent text defined for ${consentKey(purpose, source)}`);
  return entry;
}

export class ConsentError extends Error {
  code: string;

  constructor(message: string, code = "consent_error") {
    super(message);
    this.name = "ConsentError";
    this.code = code;
  }
}

function consentDocId(uid: string, purpose: ConsentPurpose, source?: ActivitySourceId): string {
  return `${uid}__${consentKey(purpose, source)}`;
}

export async function recordConsent(input: {
  uid: string;
  purpose: ConsentPurpose;
  source?: ActivitySourceId;
  granted: boolean;
}): Promise<ConsentRecord> {
  const { version, text } = consentText(input.purpose, input.source);
  const now = new Date().toISOString();
  const id = consentDocId(input.uid, input.purpose, input.source);

  const record: ConsentRecord = {
    id,
    uid: input.uid,
    purpose: input.purpose,
    version,
    // Store the wording verbatim: this is the evidence, not a reference to it.
    text,
    granted: input.granted,
    grantedAt: now,
    retention: stampRetention("consent_evidence"),
  };
  if (input.source) record.source = input.source;
  if (!input.granted) record.withdrawnAt = now;

  await adminDb().collection(CONSENT_COLLECTION).doc(id).set(record, { merge: true });
  return record;
}

export async function withdrawConsent(input: {
  uid: string;
  purpose: ConsentPurpose;
  source?: ActivitySourceId;
}): Promise<void> {
  const id = consentDocId(input.uid, input.purpose, input.source);
  await adminDb()
    .collection(CONSENT_COLLECTION)
    .doc(id)
    .set(
      { id, uid: input.uid, granted: false, withdrawnAt: new Date().toISOString() },
      { merge: true },
    );
}

export async function getConsent(
  uid: string,
  purpose: ConsentPurpose,
  source?: ActivitySourceId,
): Promise<ConsentRecord | null> {
  const snap = await adminDb()
    .collection(CONSENT_COLLECTION)
    .doc(consentDocId(uid, purpose, source))
    .get();
  return snap.exists ? (snap.data() as ConsentRecord) : null;
}

export async function listConsents(uid: string): Promise<ConsentRecord[]> {
  const snap = await adminDb().collection(CONSENT_COLLECTION).where("uid", "==", uid).get();
  return snap.docs.map((doc) => doc.data() as ConsentRecord);
}

/**
 * Gate for every third-party pull. Fails closed: no record, a withdrawn record,
 * or a record against superseded wording all block ingestion. Re-consent is
 * required after a text change, which is the point of versioning it.
 */
export async function requireConsent(
  uid: string,
  purpose: ConsentPurpose,
  source?: ActivitySourceId,
): Promise<ConsentRecord> {
  const record = await getConsent(uid, purpose, source);
  if (!record || !record.granted) {
    throw new ConsentError("Consent has not been given for this purpose", "consent_missing");
  }

  const current = consentText(purpose, source);
  if (record.version !== current.version) {
    throw new ConsentError(
      "Consent was given against an older version of the consent text",
      "consent_outdated",
    );
  }

  return record;
}
