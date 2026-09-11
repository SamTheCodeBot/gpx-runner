/**
 * intervals.icu HTTP client.
 *
 * Every endpoint, parameter and response field below was taken from the live
 * OpenAPI document at https://intervals.icu/api/v1/docs and the maintainer's
 * OAuth guide (forum.intervals.icu/t/intervals-icu-oauth-support/2759).
 * Nothing here is inferred.
 *
 * Verified:
 *   authorize        GET  https://intervals.icu/oauth/authorize
 *                         ?client_id&redirect_uri&scope&state
 *   token exchange   POST https://intervals.icu/api/oauth/token
 *                         form: client_id, client_secret, code
 *                         -> { token_type, access_token, scope, athlete{id,name} }
 *   revoke           DELETE https://intervals.icu/api/v1/disconnect-app  (Bearer)
 *   list activities  GET  /api/v1/athlete/{id}/activities
 *                         ?oldest (required, local ISO) &newest &limit &fields
 *   gpx download     GET  /api/v1/activity/{id}/gpx-file?power&hr
 *   api key auth     HTTP basic, username "API_KEY", password the key
 *   scopes           ACTIVITY|WELLNESS|CALENDAR|CHATS|LIBRARY|SETTINGS, each
 *                    :READ or :WRITE, comma separated
 *   rate limits      X-RateLimit-Limit / X-RateLimit-Remaining headers;
 *                    429 + Retry-After (seconds); also 10 req/s per IP
 *
 * Note the token response carries no refresh_token and no expiry: intervals.icu
 * issues long-lived bearer tokens. There is therefore no refresh path, and a
 * 401 means the user revoked access and must reconnect.
 */

const INTERVALS_BASE = "https://intervals.icu";

/** We only ask for read access to activities. Nothing else is any of our business. */
export const INTERVALS_SCOPE = "ACTIVITY:READ";

/**
 * Mirrors the `StravaApiError` diagnostics pattern: carry the status and body
 * so the sync route can turn a failure into a specific, actionable code rather
 * than a generic 500.
 */
export class IntervalsApiError extends Error {
  status: number;
  body: string;
  /** Seconds to wait, parsed from Retry-After on a 429. */
  retryAfterSeconds?: number;

  constructor(message: string, status: number, body: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "IntervalsApiError";
    this.status = status;
    this.body = body;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type IntervalsTokenResponse = {
  token_type: string;
  access_token: string;
  scope?: string;
  athlete?: {
    id: string;
    name?: string;
  };
};

/** Subset of the `Activity` schema this product is allowed to care about. */
export type IntervalsActivity = {
  id: string;
  name?: string;
  type?: string;
  start_date_local?: string;
  start_date?: string;
  timezone?: string;
  distance?: number;
  icu_distance?: number;
  moving_time?: number;
  elapsed_time?: number;
  total_elevation_gain?: number;
  source?: string;
  /** Present stream names; used to tell whether there is a GPS track at all. */
  stream_types?: string[];
};

/**
 * Fields we request. `fields` limits the response to these, which is data
 * minimisation applied at the wire level: heart rate, power and every other
 * physiological metric are never even transferred.
 */
export const INTERVALS_ACTIVITY_FIELDS = [
  "id",
  "name",
  "type",
  "start_date_local",
  "timezone",
  "distance",
  "moving_time",
  "elapsed_time",
  "total_elevation_gain",
  "source",
  "stream_types",
] as const;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

/**
 * intervals.icu sits behind Cloudflare, which challenges unfamiliar client
 * agents. A descriptive, stable user agent avoids that and is good manners.
 */
function userAgent(): string {
  return process.env.INTERVALS_USER_AGENT || "GPXRunner/1.0 (+https://github.com/gpx-runner)";
}

export type IntervalsAuth = { accessToken?: string; apiKey?: string };

function authHeader(auth: IntervalsAuth): string {
  if (auth.accessToken) return `Bearer ${auth.accessToken}`;
  if (auth.apiKey) {
    // Personal API key path: HTTP basic with the literal username "API_KEY".
    return `Basic ${Buffer.from(`API_KEY:${auth.apiKey}`).toString("base64")}`;
  }
  throw new Error("No intervals.icu credentials supplied");
}

function retryAfterFrom(res: Response): number | undefined {
  const header = res.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds : undefined;
}

async function intervalsFetch(path: string, auth: IntervalsAuth, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${INTERVALS_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      authorization: authHeader(auth),
      "user-agent": userAgent(),
    },
  });

  if (!res.ok) {
    // Body is read for diagnostics only; it never contains our credentials.
    throw new IntervalsApiError(
      `intervals.icu API request failed: ${path}`,
      res.status,
      await res.text().catch(() => ""),
      retryAfterFrom(res),
    );
  }

  return res;
}

export function intervalsAuthorizeUrl(input: { redirectUri: string; state: string }): string {
  const url = new URL(`${INTERVALS_BASE}/oauth/authorize`);
  url.searchParams.set("client_id", requireEnv("INTERVALS_CLIENT_ID"));
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", INTERVALS_SCOPE);
  url.searchParams.set("state", input.state);
  return url.toString();
}

export async function exchangeIntervalsCode(code: string): Promise<IntervalsTokenResponse> {
  const body = new URLSearchParams();
  body.set("client_id", requireEnv("INTERVALS_CLIENT_ID"));
  body.set("client_secret", requireEnv("INTERVALS_CLIENT_SECRET"));
  body.set("code", code);

  const res = await fetch(`${INTERVALS_BASE}/api/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": userAgent(),
    },
    body,
  });

  if (!res.ok) {
    throw new IntervalsApiError(
      "intervals.icu token exchange failed",
      res.status,
      await res.text().catch(() => ""),
      retryAfterFrom(res),
    );
  }

  return (await res.json()) as IntervalsTokenResponse;
}

/**
 * Revoke our access for this athlete. Also stops webhook delivery for them,
 * which is exactly what erasure and disconnect both need.
 */
export async function disconnectIntervalsApp(auth: IntervalsAuth): Promise<void> {
  await intervalsFetch("/api/v1/disconnect-app", auth, { method: "DELETE" });
}

/** The athlete profile, used to learn the athlete id on the API-key path. */
export async function getIntervalsAthlete(auth: IntervalsAuth): Promise<{ id: string; name?: string }> {
  // "0" resolves to the athlete owning the credential, per the API docs.
  const res = await intervalsFetch("/api/v1/athlete/0/profile", auth);
  const profile = (await res.json()) as { athlete?: { id?: string; name?: string }; id?: string; name?: string };
  const id = profile.athlete?.id ?? profile.id;
  if (!id) throw new Error("intervals.icu profile response did not include an athlete id");
  return { id: String(id), name: profile.athlete?.name ?? profile.name };
}

export async function listIntervalsActivities(
  auth: IntervalsAuth,
  input: { athleteId: string; oldest: string; newest?: string; limit?: number },
): Promise<IntervalsActivity[]> {
  const params = new URLSearchParams();
  // `oldest` is a required local ISO-8601 date or date-time.
  params.set("oldest", input.oldest);
  if (input.newest) params.set("newest", input.newest);
  if (input.limit) params.set("limit", String(input.limit));
  params.set("fields", INTERVALS_ACTIVITY_FIELDS.join(","));

  const res = await intervalsFetch(
    `/api/v1/athlete/${encodeURIComponent(input.athleteId)}/activities?${params.toString()}`,
    auth,
  );

  const activities = (await res.json()) as IntervalsActivity[];
  return Array.isArray(activities) ? activities : [];
}

/**
 * Download the GPX intervals.icu generates for an activity.
 *
 * `power=false&hr=false` is a deliberate GDPR choice, not a default: heart rate
 * is Art. 9 special-category data and we do not want it in the file at all,
 * never mind in our storage.
 */
export async function downloadIntervalsGpx(auth: IntervalsAuth, activityId: string): Promise<string> {
  const res = await intervalsFetch(
    `/api/v1/activity/${encodeURIComponent(activityId)}/gpx-file?power=false&hr=false`,
    auth,
  );
  return res.text();
}
