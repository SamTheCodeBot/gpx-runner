import { adminDb } from "@/lib/firebaseAdmin";
import { openSecret, sealSecret } from "@/lib/tokenCrypto";
import type {
  ActivityCursor,
  ActivitySourceId,
  ConnectResult,
  ProviderConnection,
  SourceCredentials,
} from "@/app/types";

/**
 * Provider connections: one document per (user, source).
 *
 * Credentials only ever exist in Firestore as AES-256-GCM envelopes, bound to
 * `${uid}:${source}` as additional authenticated data. This module is the only
 * place that opens them; routes ask for `SourceCredentials` and hand them
 * straight to an adapter.
 */

export const CONNECTION_COLLECTION = "providerConnections";

export function connectionId(uid: string, source: ActivitySourceId): string {
  return `${uid}__${source}`;
}

function aad(uid: string, source: ActivitySourceId): string {
  return `${uid}:${source}`;
}

export async function getConnection(
  uid: string,
  source: ActivitySourceId,
): Promise<ProviderConnection | null> {
  const snap = await adminDb().collection(CONNECTION_COLLECTION).doc(connectionId(uid, source)).get();
  return snap.exists ? (snap.data() as ProviderConnection) : null;
}

export async function listConnections(uid: string): Promise<ProviderConnection[]> {
  const snap = await adminDb().collection(CONNECTION_COLLECTION).where("uid", "==", uid).get();
  return snap.docs.map((doc) => doc.data() as ProviderConnection);
}

/** Find the owner of an inbound webhook by the provider's own account id. */
export async function findConnectionByExternalId(
  source: ActivitySourceId,
  externalId: string,
): Promise<ProviderConnection | null> {
  const snap = await adminDb()
    .collection(CONNECTION_COLLECTION)
    .where("source", "==", source)
    .where("externalId", "==", externalId)
    .limit(1)
    .get();
  return snap.empty ? null : (snap.docs[0].data() as ProviderConnection);
}

export async function saveConnection(input: {
  uid: string;
  source: ActivitySourceId;
  result: ConnectResult;
  authMode: ProviderConnection["authMode"];
  consentId?: string;
}): Promise<ProviderConnection> {
  const { uid, source, result } = input;
  const existing = await getConnection(uid, source);
  const now = new Date().toISOString();

  const connection: ProviderConnection = {
    uid,
    source,
    externalId: result.externalId,
    authMode: input.authMode,
    connectedAt: existing?.connectedAt ?? now,
    updatedAt: now,
  };

  if (result.displayName) connection.displayName = result.displayName;
  if (result.scope) connection.scope = result.scope;
  if (existing?.lastSyncAt) connection.lastSyncAt = existing.lastSyncAt;
  if (existing?.cursor) connection.cursor = existing.cursor;
  if (input.consentId) connection.consentId = input.consentId;

  // Tokens are sealed here and nowhere else.
  if (result.accessToken) connection.accessTokenEnc = sealSecret(result.accessToken, aad(uid, source));
  if (result.apiKey) connection.apiKeyEnc = sealSecret(result.apiKey, aad(uid, source));

  await adminDb()
    .collection(CONNECTION_COLLECTION)
    .doc(connectionId(uid, source))
    .set(connection, { merge: true });

  return connection;
}

/** Decrypt a connection's credentials for an immediate provider call. */
export function openCredentials(connection: ProviderConnection): SourceCredentials {
  const credentials: SourceCredentials = { externalId: connection.externalId };

  if (connection.accessTokenEnc) {
    credentials.accessToken = openSecret(connection.accessTokenEnc, aad(connection.uid, connection.source));
  }
  if (connection.apiKeyEnc) {
    credentials.apiKey = openSecret(connection.apiKeyEnc, aad(connection.uid, connection.source));
  }
  if (connection.scope) credentials.scope = connection.scope;

  return credentials;
}

export async function updateCursor(
  uid: string,
  source: ActivitySourceId,
  cursor: ActivityCursor,
): Promise<void> {
  await adminDb()
    .collection(CONNECTION_COLLECTION)
    .doc(connectionId(uid, source))
    .set({ cursor, lastSyncAt: new Date().toISOString() }, { merge: true });
}

export async function deleteConnection(uid: string, source: ActivitySourceId): Promise<void> {
  await adminDb().collection(CONNECTION_COLLECTION).doc(connectionId(uid, source)).delete();
}

/**
 * Redacted view for API responses. The encrypted envelopes never leave the
 * server, not even in their sealed form.
 */
export function publicConnectionView(connection: ProviderConnection) {
  return {
    source: connection.source,
    externalId: connection.externalId,
    displayName: connection.displayName,
    scope: connection.scope,
    authMode: connection.authMode,
    connectedAt: connection.connectedAt,
    lastSyncAt: connection.lastSyncAt,
  };
}
