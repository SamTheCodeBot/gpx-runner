import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { verifyFirebaseIdToken } from "@/lib/firebaseAuthServer";

export const dynamic = "force-dynamic";

// GET /api/routes/summaries - returns lightweight route list (no coordinates/samples)
export async function GET(req: NextRequest) {
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

    const userId = decodedToken.uid;
    const db = adminDb();

    const q = db.collection("routes").where("userId", "==", userId);
    const snap = await q.get();

    // Return only the fields needed for list rendering
    // No coordinates, no samples — dramatically reduces payload
    const summaries = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        name: d.name || "Untitled",
        date: d.date || new Date(0).toISOString(),
        distance: typeof d.distance === "number" ? d.distance : 0,
        elevationGain: typeof d.elevationGain === "number" ? d.elevationGain : 0,
        duration: d.duration,
        color: d.color || "#fc4c02",
        type: d.type || "road",
        isRoundTrip: d.isRoundTrip ?? false,
        countries: d.countries || [],
        hasTcx: d.hasTcx ?? false,
        strava: d.strava || null,
      };
    });

    // Sort by date descending (newest first)
    summaries.sort((a, b) => new Date(b.date).valueOf() - new Date(a.date).valueOf());

    return NextResponse.json({ routes: summaries });
  } catch (err) {
    console.error("[routes/summaries]", err);
    return NextResponse.json({ error: "Failed to fetch routes" }, { status: 500 });
  }
}
