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
    const typeFilter = req.nextUrl.searchParams.get("type"); // road | trail | mixed | all

    let query: FirebaseFirestore.Query = db.collection("routes");
    if (typeFilter && typeFilter !== "all") {
      query = query.where("type", "==", typeFilter);
    }

    const snap = await query.limit(1000).get();

    const routes = snap.docs
      .map((doc: FirebaseFirestore.QueryDocumentSnapshot) => {
        const data = doc.data();
        return {
          id: doc.id,
          name: data.name || "Unnamed",
          type: data.type || "road",
          coordinates: Array.isArray(data.coordinates)
            ? data.coordinates.map((c: { lat: number; lon: number }) => [c.lon, c.lat] as [number, number])
            : [],
        };
      })
      .filter((r: { coordinates: unknown[] }) => r.coordinates.length > 0);

    return NextResponse.json({ routes });
  } catch (err) {
    console.error("[crewcaptain/routes]", err);
    return NextResponse.json({ error: "Failed to fetch routes" }, { status: 500 });
  }
}