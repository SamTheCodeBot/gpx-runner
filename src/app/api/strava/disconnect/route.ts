import { FieldValue } from "firebase-admin/firestore";
import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { verifyFirebaseIdToken } from "@/lib/firebaseAuthServer";
import { deauthorizeStrava, refreshStravaToken } from "@/lib/strava";
import type { UserProfile } from "@/app/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getProfileDoc(uid: string) {
  const db = adminDb();
  const snap = await db.collection("userProfiles").where("userId", "==", uid).limit(1).get();
  if (!snap.empty) return snap.docs[0];
  const byId = await db.collection("userProfiles").doc(uid).get();
  return byId.exists ? byId : null;
}

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization") ?? "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
    if (!idToken) {
      return NextResponse.json({ error: "Missing Firebase auth token" }, { status: 401 });
    }

    const decoded = await verifyFirebaseIdToken(idToken);
    const profileDoc = await getProfileDoc(decoded.uid);
    if (!profileDoc) {
      return NextResponse.json({ ok: true });
    }

    const profile = profileDoc.data() as UserProfile;
    const strava = profile.strava;
    if (strava?.accessToken) {
      try {
        const now = Math.floor(Date.now() / 1000);
        const accessToken = strava.expiresAt > now + 60
          ? strava.accessToken
          : (await refreshStravaToken(strava.refreshToken)).access_token;
        await deauthorizeStrava(accessToken);
      } catch (error) {
        console.warn("[strava/disconnect] Strava deauthorize failed; removing local connection", error);
      }
    }

    await profileDoc.ref.update({
      strava: FieldValue.delete(),
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[strava/disconnect]", error);
    return NextResponse.json({ error: "Failed to disconnect Strava" }, { status: 500 });
  }
}
