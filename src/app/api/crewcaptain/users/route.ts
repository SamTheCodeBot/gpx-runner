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

    // Get all regular users
    const snap = await db.collection("userProfiles").limit(500).get();

    // Count routes for deleted/missing users (userId points to non-existent profile)
    const allRoutesSnap = await db.collection("routes").count().get();
    const totalRouteCount = allRoutesSnap.data().count ?? 0;

    const users = await Promise.all(
      snap.docs.map(async (doc: FirebaseFirestore.QueryDocumentSnapshot) => {
        const data = doc.data();
        // Count routes for this user
        const routesSnap = await db.collection("routes").where("userId", "==", doc.id).count().get();
        return {
          id: doc.id,
          username: data.username || "Unknown",
          email: data.email || "",
          routeCount: routesSnap.data().count ?? 0,
          stravaConnected: !!data.stravaAccessToken,
          isAdmin: data.isAdmin ?? false,
        };
      })
    );


    // Calculate deleted users' routes
    const activeUserRouteCount = users.reduce((sum, u) => sum + u.routeCount, 0);
    const deletedRouteCount = totalRouteCount - activeUserRouteCount;


    return NextResponse.json({ users, deletedRouteCount });
  } catch (err) {
    console.error("[crewcaptain/users]", err);
    return NextResponse.json({ error: "Failed to fetch users" }, { status: 500 });
  }
}