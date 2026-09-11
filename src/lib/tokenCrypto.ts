import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "crypto";

/**
 * Encryption at rest for third-party provider credentials.
 *
 * GDPR Art. 32 (security of processing): an access token to someone's activity
 * provider is as sensitive as the data behind it. Tokens are therefore never
 * written to Firestore in the clear \u2014 they are sealed here with AES-256-GCM and
 * only opened in-memory in a server route that is about to call the provider.
 *
 * Rules for callers:
 *   - Never log a plaintext token, a sealed envelope, or the key.
 *   - Never return either through an API response.
 *   - Decrypt as late as possible and keep the value in a local variable.
 *
 * Envelope format: `v1.<iv>.<authTag>.<ciphertext>`, each part base64url.
 * The version prefix exists so the key or algorithm can be rotated later
 * without guessing how an existing value was produced.
 */

const ENVELOPE_VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const KEY_BYTES = 32; // AES-256

export class TokenCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenCryptoError";
  }
}

function decodeKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const candidates: Buffer[] = [];

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) candidates.push(Buffer.from(trimmed, "hex"));
  candidates.push(Buffer.from(trimmed, "base64"));

  const key = candidates.find((candidate) => candidate.length === KEY_BYTES);
  if (!key) {
    throw new TokenCryptoError(
      "TOKEN_ENCRYPTION_KEY must be 32 bytes, supplied as 64 hex characters or base64",
    );
  }

  return key;
}

function encryptionKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new TokenCryptoError("Missing env var: TOKEN_ENCRYPTION_KEY");
  return decodeKey(raw);
}

/** True when the server is configured to store provider tokens at all. */
export function tokenEncryptionConfigured(): boolean {
  try {
    encryptionKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * Seal a secret for storage. `aad` binds the envelope to its context (we pass
 * `${uid}:${source}`), so a stolen envelope cannot be replayed under another
 * user or provider even if an attacker can write to Firestore.
 */
export function sealSecret(plaintext: string, aad: string): string {
  if (!plaintext) throw new TokenCryptoError("Refusing to seal an empty secret");

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    ENVELOPE_VERSION,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/** Open an envelope produced by `sealSecret`. Throws if it was tampered with. */
export function openSecret(envelope: string, aad: string): string {
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new TokenCryptoError("Unrecognised encrypted token envelope");
  }

  const [, encodedIv, encodedTag, encodedCiphertext] = parts;

  try {
    const decipher = createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(encodedIv, "base64url"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Deliberately opaque: never echo key material or ciphertext into logs.
    throw new TokenCryptoError("Failed to decrypt provider token");
  }
}

/** Constant-time comparison for shared secrets (webhook verification). */
export function secretsMatch(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
