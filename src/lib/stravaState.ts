import { createOAuthState, verifyOAuthState, type OAuthStatePayload } from "./oauthState";

/**
 * Strava OAuth state.
 *
 * The signing logic now lives in `src/lib/oauthState.ts` so every adapter
 * shares one implementation. Behaviour here is unchanged: same payload fields,
 * same signing secret, same 10 minute expiry, so states minted by the previous
 * version still verify.
 */

type StravaOAuthState = OAuthStatePayload;

function stravaSecret(): string {
  const secret = process.env.STRAVA_CLIENT_SECRET;
  if (!secret) throw new Error("Missing env var: STRAVA_CLIENT_SECRET");
  return secret;
}

export function createStravaState(uid: string): string {
  return createOAuthState(uid, { secret: stravaSecret() });
}

export function verifyStravaState(state: string): StravaOAuthState {
  return verifyOAuthState(state, { secret: stravaSecret() });
}
