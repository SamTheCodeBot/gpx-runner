import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { requireUid } from "@/lib/firebaseAuthServer";
import { FIRESTORE_QUOTA_CODE, isQuotaExhausted } from "@/lib/firestoreQuota";
import { readTrackCoordinates } from "@/lib/track/polyline";

export const dynamic = "force-dynamic";
/**
 * This route decodes every route's full-resolution polyline server-side
 * (readTrackCoordinates -- a real decode, not a byte copy) before thinning
 * each one down to 120 points. On a small account that is instant; on an
 * account with 1,442 routes that is 1,442 decodes in one request, with no
 * override here -- meaning Vercel's un-overridden default duration applied,
 * while every OTHER route in this app doing comparable per-route work
 * (street-projects, routes/suggest) already explicitly raises past it (see
 * maxDuration elsewhere under src/app/api). A function killed by its own
 * platform mid-response returns exactly what this bug looked like end to
 * end: a plain failed response to the client, indistinguishable from a
 * real auth failure unless someone thought to check the account size the
 * failure correlated with.
 */
export const maxDuration = 60;

/**
 * How many points an overview line needs. The map already simplifies a
 * selected route's full track down to 500 points before drawing it
 * (simplifyPositions in Map.tsx); the *overview* -- every route at once,
 * drawn thin and half-transparent -- never needed more detail than this to
 * look right, and never got less than "nothing" before this change.
 */
const OVERVIEW_POINT_CAP = 120;

function thinForOverview(coords: [number, number][]): [number, number][] {
  if (coords.length <= OVERVIEW_POINT_CAP) return coords;
  const step = Math.ceil(coords.length / OVERVIEW_POINT_CAP);
  return coords.filter((_, i) => i % step === 0 || i === coords.length - 1);
}

// GET /api/routes/summaries - returns a lightweight route list: every field
// the stats bar and route list need, plus a thinned-to-120-point track good
// enough for the overview map -- never the full-resolution geometry only a
// selected route needs (that stays behind GET /api/routes/[id]).
export async function GET(req: NextRequest) {
  try {
    const userId = await requireUid(req);
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const db = adminDb();

    const q = db.collection("routes")
      .where("userId", "==", userId)
      .select(
        "name",
        "date",
        "distance",
        "elevationGain",
        "duration",
        "color",
        "type",
        "isRoundTrip",
        "countries",
        "hasTcx",
        "strava",
        "track",
        "coordinates",
      );
    const snap = await q.get();

    // Return the fields needed for list rendering plus a thinned track —
    // no full-resolution geometry, no samples, still a fraction of the
    // full-document payload per route.
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
        coordinates: thinForOverview(readTrackCoordinates(d)),
      };
    });

    // Sort by date descending (newest first)
    summaries.sort((a, b) => new Date(b.date).valueOf() - new Date(a.date).valueOf());

    return NextResponse.json({ routes: summaries });
  } catch (err) {
    console.error("[routes/summaries]", err);
    // A spent daily quota takes out every read in the app at once. Saying so
    // beats a list that silently renders empty.
    if (isQuotaExhausted(err)) {
      return NextResponse.json(
        { error: "Failed to fetch routes", code: FIRESTORE_QUOTA_CODE },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: "Failed to fetch routes" }, { status: 500 });
  }
}
