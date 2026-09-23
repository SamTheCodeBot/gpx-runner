import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { readTrackCoordinates } from "@/lib/track/polyline";
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

    // The wire shape stays what every client already expects: `coordinates` as
    // [lon, lat] pairs. Storage moved to an encoded polyline on `track`, and
    // that is a storage detail, so it is decoded here rather than pushed out to
    // each caller. Documents written before the change still carry the old
    // array and read back identically.
    const { track: _storedTrack, ...rest } = data as Record<string, unknown>;
    return NextResponse.json({
      route: { id: docSnap.id, ...rest, coordinates: readTrackCoordinates(data) },
    });
  } catch (err) {
    console.error("[routes/[id]]", err);
    return NextResponse.json({ error: "Failed to fetch route" }, { status: 500 });
  }
}
