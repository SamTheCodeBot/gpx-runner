import { NextRequest, NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebaseAdmin";
import { createStravaState } from "@/lib/stravaState";
import { getAppUrl } from "@/lib/strava";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization") ?? "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
    if (!idToken) {
      return NextResponse.json({ error: "Missing Firebase auth token" }, { status: 401 });
    }

    const decoded = await adminAuth().verifyIdToken(idToken);
    const clientId = process.env.STRAVA_CLIENT_ID;
    if (!clientId) throw new Error("Missing env var: STRAVA_CLIENT_ID");

    const redirectUri = `${getAppUrl()}/api/strava/callback`;
    const url = new URL("https://www.strava.com/oauth/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("approval_prompt", "auto");
    url.searchParams.set("scope", "read,activity:read_all");
    url.searchParams.set("state", createStravaState(decoded.uid));

    return NextResponse.json({ url: url.toString() });
  } catch (error) {
    console.error("[strava/connect]", error);
    return NextResponse.json({ error: "Failed to start Strava connection" }, { status: 500 });
  }
}
