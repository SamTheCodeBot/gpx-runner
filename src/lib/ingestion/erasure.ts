import { createHash } from "crypto";
import type { Query } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebaseAdmin";
import { CONSENT_COLLECTION } from "./consent";
import { CONNECTION_COLLECTION, listConnections, openCredentials } from "./connections";
import { getActivitySource } from "./registry";
import { ACTIVITY_COLLECTION, RAW_PAYLOAD_COLLECTION, ROUTE_COLLECTION } from "./store";
import { deleteProjectsForOwner } from "@/lib/streetProjects";
import type { ActivitySourceId } from "@/app/types";

/**
 * Right to erasure (GDPR Art. 17).
 *
 * "Delete my account" has to mean it. This performs a hard delete \u2014 no soft
 * flags, no tombstones holding the data \u2014 across every collection that can hold
 * something about the user, and it revokes upstream provider access first so we
 * stop receiving new data about someone who asked us to forget them.
 *
 * The only thing that survives is an unlinkable receipt: a salted hash of the
 * uid plus counts and a timestamp, which lets the controller demonstrate the
 * erasure happened without retaining an identifier that points back at a
 * person.
 */

export const ERASURE_LOG_COLLECTION = "erasureLog";

export type ErasureScope = "account" | ActivitySourceId;

export type ErasureReceipt = {
  receiptId: string;
  scope: ErasureScope;
  erasedAt: string;
  deleted: Record<string, number>;
  upstreamRevoked: ActivitySourceId[];
  upstreamFailed: ActivitySourceId[];
  confirmation: string;
};

/** Firestore caps a batch at 500 writes, so delete in chunks. */
async function deleteQuery(query: Query): Promise<number> {
  let deleted = 0;

  for (;;) {
    const snap = await query.limit(400).get();
    if (snap.empty) return deleted;

    const batch = adminDb().batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    deleted += snap.size;

    if (snap.size < 400) return deleted;
  }
}

function receiptId(uid: string, erasedAt: string): string {
  // Salted so the receipt cannot be brute-forced back to a uid.
  const salt = process.env.ERASURE_RECEIPT_SALT || process.env.TOKEN_ENCRYPTION_KEY || "";
  return createHash("sha256").update(`${salt}:${uid}:${erasedAt}`).digest("hex").slice(0, 32);
}

export async function eraseUserData(input: {
  uid: string;
  scope: ErasureScope;
}): Promise<ErasureReceipt> {
  const { uid, scope } = input;
  const db = adminDb();
  const erasedAt = new Date().toISOString();
  const deleted: Record<string, number> = {};
  const upstreamRevoked: ActivitySourceId[] = [];
  const upstreamFailed: ActivitySourceId[] = [];

  // 1. Stop the inflow first: revoke upstream before deleting the tokens that
  //    would let us do the revoking.
  const connections = await listConnections(uid);
  for (const connection of connections) {
    if (scope !== "account" && connection.source !== scope) continue;

    try {
      await getActivitySource(connection.source).disconnect(openCredentials(connection));
      upstreamRevoked.push(connection.source);
    } catch (error) {
      // Recorded, not swallowed: the user is told which provider must be
      // revoked by hand, and local deletion continues regardless.
      upstreamFailed.push(connection.source);
      console.warn("[gdpr/erase] upstream revoke failed", {
        source: connection.source,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const scoped = <T extends Query>(query: T, field: string): Query =>
    scope === "account" ? query : query.where(field, "==", scope);

  // 2. Canonical activities.
  deleted.activities = await deleteQuery(
    scoped(db.collection(ACTIVITY_COLLECTION).where("ownerUid", "==", uid), "source"),
  );

  // 3. Raw provider payloads.
  deleted.rawPayloads = await deleteQuery(
    scoped(db.collection(RAW_PAYLOAD_COLLECTION).where("ownerUid", "==", uid), "source"),
  );

  // 4. Tracks. A source-scoped erasure only removes routes that source created,
  //    so a user's own uploads and Strava-synced runs are left alone.
  deleted.routes =
    scope === "account"
      ? await deleteQuery(db.collection(ROUTE_COLLECTION).where("userId", "==", uid))
      : await deleteQuery(
          db.collection(ROUTE_COLLECTION).where("userId", "==", uid).where("activity.source", "==", scope),
        );

  // 5. Provider credentials.
  deleted.connections = await deleteQuery(
    scoped(db.collection(CONNECTION_COLLECTION).where("uid", "==", uid), "source"),
  );

  // 6. Consent records. Erasure removes the consent itself; the receipt below
  //    is what remains as evidence that the erasure was carried out.
  deleted.consents =
    scope === "account"
      ? await deleteQuery(db.collection(CONSENT_COLLECTION).where("uid", "==", uid))
      : await deleteQuery(db.collection(CONSENT_COLLECTION).where("uid", "==", uid).where("source", "==", scope));

  // 7. Street completion projects. Not source-scoped: a project is the user's
  //    own choice of area, not anything a provider sent us, so it survives a
  //    single provider being erased and goes with a full account erasure.
  if (scope === "account") {
    deleted.streetProjects = await deleteProjectsForOwner(uid);
  }

  // 8. The profile document itself, on a full account erasure.
  if (scope === "account") {
    deleted.profiles = await deleteQuery(db.collection("userProfiles").where("userId", "==", uid));
    const byId = db.collection("userProfiles").doc(uid);
    if ((await byId.get()).exists) {
      await byId.delete();
      deleted.profiles += 1;
    }
  }

  const id = receiptId(uid, erasedAt);
  const confirmation =
    scope === "account"
      ? `All personal data held by GPX Runner for this account was permanently deleted on ${erasedAt}.`
      : `All personal data held by GPX Runner from ${scope} was permanently deleted on ${erasedAt}.`;

  // Unlinkable receipt: no uid, no email, no location data.
  await db.collection(ERASURE_LOG_COLLECTION).doc(id).set({
    receiptId: id,
    scope,
    erasedAt,
    deleted,
    upstreamRevoked,
    upstreamFailed,
  });

  return { receiptId: id, scope, erasedAt, deleted, upstreamRevoked, upstreamFailed, confirmation };
}
