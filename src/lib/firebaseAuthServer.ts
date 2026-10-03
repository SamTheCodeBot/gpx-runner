import { createVerify } from "crypto";

type FirebaseJwtHeader = {
  alg?: string;
  kid?: string;
};

type FirebaseJwtPayload = {
  aud?: string;
  exp?: number;
  iat?: number;
  iss?: string;
  sub?: string;
  user_id?: string;
  email?: string;
};

export type VerifiedFirebaseToken = FirebaseJwtPayload & {
  uid: string;
};

type CertCache = {
  expiresAt: number;
  certs: Record<string, string>;
};

const FIREBASE_CERTS_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

let certCache: CertCache | null = null;

function requireProjectId(): string {
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error("Missing env var: NEXT_PUBLIC_FIREBASE_PROJECT_ID");
  return projectId;
}

function decodeBase64UrlJson<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
}

async function getFirebaseCerts(): Promise<Record<string, string>> {
  const now = Date.now();
  if (certCache && certCache.expiresAt > now + 30_000) {
    return certCache.certs;
  }

  const res = await fetch(FIREBASE_CERTS_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch Firebase token certificates: ${res.status}`);
  }

  const cacheControl = res.headers.get("cache-control") ?? "";
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  const maxAgeSeconds = maxAgeMatch ? Number(maxAgeMatch[1]) : 60 * 60;
  const certs = (await res.json()) as Record<string, string>;

  certCache = {
    certs,
    expiresAt: now + maxAgeSeconds * 1000,
  };

  return certs;
}

/**
 * Every API route's "who is asking" check, in one place.
 *
 * Before this, routes/summaries and routes/[id] each hand-rolled the same
 * header-parse-plus-verify sequence inline, and street-projects/shared.ts had
 * its own copy as requireUid. Three copies of the same five lines is exactly
 * how one of them silently drifts from the others without anyone noticing --
 * and when routes/summaries started 401ing for real, authenticated requests
 * while the street-projects copy kept working, a byte-for-byte diff between
 * the two found nothing, because there was nothing left to find by reading:
 * the duplication itself was the risk, not a specific bug caught in the act.
 * Returns null on any failure (missing header, malformed token, expired,
 * wrong project) rather than throwing, so a route can do
 * `const uid = await requireUid(req); if (!uid) return 401;` and never see
 * the actual reason -- which is fine for a route, and logged here for anyone
 * who later needs to know which check actually failed.
 */
export async function requireUid(req: Request): Promise<string | null> {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  try {
    const token = await verifyFirebaseIdToken(header.slice(7));
    return token.uid;
  } catch (err) {
    console.error("[requireUid] token rejected:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function verifyFirebaseIdToken(idToken: string): Promise<VerifiedFirebaseToken> {
  const projectId = requireProjectId();
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Invalid Firebase ID token");

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeBase64UrlJson<FirebaseJwtHeader>(encodedHeader);
  const payload = decodeBase64UrlJson<FirebaseJwtPayload>(encodedPayload);

  if (header.alg !== "RS256") throw new Error("Invalid Firebase ID token algorithm");
  if (!header.kid) throw new Error("Missing Firebase ID token key id");

  const certs = await getFirebaseCerts();
  const cert = certs[header.kid];
  if (!cert) throw new Error("Unknown Firebase ID token key id");

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${encodedHeader}.${encodedPayload}`);
  verifier.end();

  const signature = Buffer.from(encodedSignature, "base64url");
  if (!verifier.verify(cert, signature)) {
    throw new Error("Invalid Firebase ID token signature");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const issuer = `https://securetoken.google.com/${projectId}`;
  if (payload.aud !== projectId) throw new Error("Invalid Firebase ID token audience");
  if (payload.iss !== issuer) throw new Error("Invalid Firebase ID token issuer");
  if (!payload.sub || payload.sub.length > 128) throw new Error("Invalid Firebase ID token subject");
  if (!payload.exp || payload.exp <= nowSeconds) throw new Error("Expired Firebase ID token");
  if (!payload.iat || payload.iat > nowSeconds + 60) throw new Error("Invalid Firebase ID token issue time");

  return {
    ...payload,
    uid: payload.sub,
  };
}
