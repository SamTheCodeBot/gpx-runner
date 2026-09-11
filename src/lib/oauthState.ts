import { createHmac, randomUUID, timingSafeEqual } from "crypto";

/**
 * HMAC-signed OAuth state, shared by every provider adapter.
 *
 * This is the generalised form of the pattern introduced for Strava: the state
 * carries the Firebase uid so the callback knows who came back, plus a nonce
 * and a short expiry, and it is signed with a server-side secret so a third
 * party cannot forge one. `src/lib/stravaState.ts` is a thin wrapper over this
 * module, so there is exactly one implementation to audit.
 */

export type OAuthStatePayload = {
  uid: string;
  nonce: string;
  exp: number;
  /**
   * Provider tag. Omitted for Strava so its historical state format stays
   * byte-identical; every new adapter sets it, which stops a state minted for
   * one provider being replayed against another.
   */
  provider?: string;
};

const DEFAULT_TTL_SECONDS = 10 * 60;

export type OAuthStateOptions = {
  /** Signing secret. Use a per-provider secret so they stay independent. */
  secret: string;
  provider?: string;
  ttlSeconds?: number;
};

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createOAuthState(uid: string, options: OAuthStateOptions): string {
  if (!options.secret) throw new Error("Missing OAuth state signing secret");

  const payload: OAuthStatePayload = {
    uid,
    nonce: randomUUID(),
    exp: Math.floor(Date.now() / 1000) + (options.ttlSeconds ?? DEFAULT_TTL_SECONDS),
  };
  // Only set when provided, so the serialised shape is unchanged for Strava.
  if (options.provider) payload.provider = options.provider;

  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded, options.secret)}`;
}

export function verifyOAuthState(state: string, options: OAuthStateOptions): OAuthStatePayload {
  if (!options.secret) throw new Error("Missing OAuth state signing secret");

  const [encoded, signature] = state.split(".");
  if (!encoded || !signature) throw new Error("Invalid OAuth state");

  const expected = sign(encoded, options.secret);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new Error("Invalid OAuth state signature");
  }

  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as OAuthStatePayload;
  if (!payload.uid || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("Expired OAuth state");
  }
  if (options.provider && payload.provider !== options.provider) {
    throw new Error("OAuth state provider mismatch");
  }

  return payload;
}
