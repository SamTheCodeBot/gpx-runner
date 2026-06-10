import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { verifyFirebaseIdToken } from "@/lib/firebaseAuthServer";

export const dynamic = "force-dynamic";

// GET /api/routes/[id] - fetch full route with coordinates by ID
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const idToken = authHeader.slice(7);
    let decodedToken;
    try {
      decodedToken = await verifyFirebaseIdToken(idToken);
    } catch {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    const routeId = params.id;
    const db = adminDb();

    const docRef = db.collection("routes").doc(routeId);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      return NextResponse.json({ error: "Route not found" }, { status: 404 });
    }

    const data = docSnap.data();
    if (!data || data.userId !== decodedToken.uid) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    // Return full route including coordinates and samples
    return NextResponse.json({ route: { id: docSnap.id, ...data } });
  } catch (err) {
    console.error("[routes/[id]]", err);
    return NextResponse.json({ error: "Failed to fetch route" }, { status: 500 });
  }
}
