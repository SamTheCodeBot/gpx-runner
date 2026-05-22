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

    // Enforce the allowed admin email
    if (decodedToken.email?.toLowerCase() !== ALLOWED_ADMIN_EMAIL.toLowerCase()) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const db = adminDb();

    // Count registered users
    const usersSnap = await db.collection("userProfiles").count().get();
    const registeredUsers = usersSnap.data().count ?? 0;

    // Count all routes
    const routesSnap = await db.collection("routes").count().get();
    const totalRoutes = routesSnap.data().count ?? 0;

    // Count by type
    const roadSnap = await db.collection("routes").where("type", "==", "road").count().get();
    const trailSnap = await db.collection("routes").where("type", "==", "trail").count().get();
    const mixedSnap = await db.collection("routes").where("type", "==", "mixed").count().get();

    return NextResponse.json({
      registeredUsers,
      totalRoutes,
      roadRoutes: roadSnap.data().count ?? 0,
      trailRoutes: trailSnap.data().count ?? 0,
      mixedRoutes: mixedSnap.data().count ?? 0,
    });
  } catch (err) {
    console.error("[crewcaptain/stats]", err);
    return NextResponse.json({ error: "Failed to fetch stats" }, { status: 500 });
  }
}