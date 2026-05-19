const STRAVA_API = "https://www.strava.com/api/v3";

export type StravaTokenResponse = {
  token_type: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in: number;
  athlete: {
    id: number;
    username?: string;
    firstname?: string;
    lastname?: string;
  };
  scope?: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function stravaTokenBody(params: Record<string, string>): URLSearchParams {
  const body = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => body.set(key, value));
  return body;
}

export function getAppUrl(): string {
  return requireEnv("NEXT_PUBLIC_APP_URL").replace(/\/$/, "");
}

export async function exchangeStravaCode(code: string): Promise<StravaTokenResponse> {
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: stravaTokenBody({
      client_id: requireEnv("STRAVA_CLIENT_ID"),
      client_secret: requireEnv("STRAVA_CLIENT_SECRET"),
      code,
      grant_type: "authorization_code",
    }),
  });

  if (!res.ok) {
    throw new Error(`Strava token exchange failed: ${await res.text()}`);
  }

  return res.json();
}

export async function refreshStravaToken(refreshToken: string): Promise<StravaTokenResponse> {
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: stravaTokenBody({
      client_id: requireEnv("STRAVA_CLIENT_ID"),
      client_secret: requireEnv("STRAVA_CLIENT_SECRET"),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    throw new Error(`Strava token refresh failed: ${await res.text()}`);
  }

  return res.json();
}

export async function deauthorizeStrava(accessToken: string): Promise<void> {
  const res = await fetch(`${STRAVA_API}/oauth/deauthorize`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error(`Strava deauthorize failed: ${await res.text()}`);
  }
}

export function stravaAthleteName(athlete: StravaTokenResponse["athlete"]): string | undefined {
  return [athlete.firstname, athlete.lastname].filter(Boolean).join(" ") || athlete.username;
}
