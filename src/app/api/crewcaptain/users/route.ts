import { NextRequest, NextResponse } from "next/server";
import { adminDb, adminAuth } from "@/lib/firebaseAdmin";

const ALLOWED_ADMIN_EMAIL = "mago@osterhult.com";

export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const idToken = authHeader.slice(7);
    let decodedToken;
    try {
      decodedToken = await adminAuth().verifyIdToken(idToken);
    } catch {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    if (decodedToken.email?.toLowerCase() !== ALLOWED_ADMIN_EMAIL.toLowerCase()) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const db = adminDb();

    const snap = await db.collection("userProfiles").limit(500).get();

    const allRoutesSnap = await db.collection("routes").count().get();
    const totalRouteCount = allRoutesSnap.data().count ?? 0;

    const users = await Promise.all(
      snap.docs.map(async (doc: FirebaseFirestore.QueryDocumentSnapshot) => {
        const data = doc.data();
        const uid = doc.id;

        // Get email from Firebase Auth
        let email = "";
        try {
          const userRecord = await adminAuth().getUser(uid);
          email = userRecord.email || "";
        } catch {
          email = data.email || "";
        }

        // Username: prefer displayName, fall back to username field
        const username = data.displayName || data.username || "Unknown";

        // Strava connection: check strava.accessToken
        const stravaConnected = !!(data.strava && data.strava.accessToken);

        // Route count for this user
        const routesSnap = await db.collection("routes").where("userId", "==", uid).count().get();

        return {
          id: uid,
          username,
          email,
          routeCount: routesSnap.data().count ?? 0,
          stravaConnected,
          isAdmin: data.isAdmin ?? false,
        };
      })
    );

    const activeUserRouteCount = users.reduce((sum, u) => sum + u.routeCount, 0);
    const deletedRouteCount = totalRouteCount - activeUserRouteCount;

    return NextResponse.json({ users, deletedRouteCount });
  } catch (err) {
    console.error("[crewcaptain/users]", err);
    return NextResponse.json({ error: "Failed to fetch users" }, { status: 500 });
  }
}