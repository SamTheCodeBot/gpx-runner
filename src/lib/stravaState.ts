import { createHmac, randomUUID, timingSafeEqual } from "crypto";

type StravaOAuthState = {
  uid: string;
  nonce: string;
  exp: number;
};

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payload: string): string {
  const secret = process.env.STRAVA_CLIENT_SECRET;
  if (!secret) throw new Error("Missing env var: STRAVA_CLIENT_SECRET");
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createStravaState(uid: string): string {
  const payload: StravaOAuthState = {
    uid,
    nonce: randomUUID(),
    exp: Math.floor(Date.now() / 1000) + 10 * 60,
  };
  const encoded = base64Url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded)}`;
}

export function verifyStravaState(state: string): StravaOAuthState {
  const [encoded, signature] = state.split(".");
  if (!encoded || !signature) throw new Error("Invalid OAuth state");

  const expected = sign(encoded);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new Error("Invalid OAuth state signature");
  }

  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as StravaOAuthState;
  if (!payload.uid || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("Expired OAuth state");
  }

  return payload;
}
