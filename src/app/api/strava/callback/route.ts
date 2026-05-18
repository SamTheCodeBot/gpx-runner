import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { exchangeStravaCode, stravaAthleteName } from "@/lib/strava";
import { verifyStravaState } from "@/lib/stravaState";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getProfileRef(uid: string) {
  const db = adminDb();
  const snap = await db.collection("userProfiles").where("userId", "==", uid).limit(1).get();
  if (!snap.empty) return snap.docs[0].ref;
  return db.collection("userProfiles").doc(uid);
}

export async function GET(req: NextRequest) {
  const redirectBase = req.nextUrl.origin;

  try {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get("code");
    const scope = searchParams.get("scope") ?? "";
    const state = searchParams.get("state") ?? "";
    const error = searchParams.get("error");

    if (error) {
      return NextResponse.redirect(`${redirectBase}/profile?strava=denied`);
    }

    if (!code || !state) {
      return NextResponse.redirect(`${redirectBase}/profile?strava=error`);
    }

    if (!scope.includes("activity:read")) {
      return NextResponse.redirect(`${redirectBase}/profile?strava=scope`);
    }

    const { uid } = verifyStravaState(state);
    const token = await exchangeStravaCode(code);
    const now = new Date().toISOString();
    const profileRef = await getProfileRef(uid);

    await profileRef.set({
      userId: uid,
      strava: {
        athleteId: token.athlete.id,
        athleteName: stravaAthleteName(token.athlete),
        scope,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: token.expires_at,
        connectedAt: now,
        updatedAt: now,
      },
    }, { merge: true });

    return NextResponse.redirect(`${redirectBase}/profile?strava=connected`);
  } catch (error) {
    console.error("[strava/callback]", error);
    return NextResponse.redirect(`${redirectBase}/profile?strava=error`);
  }
}
