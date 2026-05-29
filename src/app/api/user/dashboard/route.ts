import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { verifyFirebaseIdToken } from "@/lib/firebaseAuthServer";

export const dynamic = "force-dynamic";

function compactCoordinates(rawCoordinates: unknown): [number, number][] {
  if (!Array.isArray(rawCoordinates)) return [];

  const coordinates = rawCoordinates
    .map((coordinate) => {
      if (Array.isArray(coordinate) && typeof coordinate[0] === "number" && typeof coordinate[1] === "number") {
        return [coordinate[0], coordinate[1]] as [number, number];
      }
      if (
        coordinate &&
        typeof coordinate === "object" &&
        "lat" in coordinate &&
        "lon" in coordinate &&
        typeof coordinate.lat === "number" &&
        typeof coordinate.lon === "number"
      ) {
        return [coordinate.lon, coordinate.lat] as [number, number];
      }
      return null;
    })
    .filter((coordinate): coordinate is [number, number] => coordinate !== null);

  if (coordinates.length <= 50) return coordinates;

  const step = Math.ceil(coordinates.length / 50);
  return coordinates.filter((_, index) => (
    index === 0 || index === coordinates.length - 1 || index % step === 0
  ));
}

// GET /api/user/dashboard - all initial data in one round trip
// Returns { profile, routes, favorites } to replace 3+ sequential Firestore queries
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

    // Fire all reads in parallel — single round trip to Firestore
    const [routesSnap, profileSnap] = await Promise.all([
      db.collection("routes")
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
          "coordinates",
          "hasTcx",
          "strava",
        )
        .get(),
      db.collection("userProfiles")
        .where("userId", "==", userId)
        .select(
          "username",
          "displayName",
          "avatar",
          "joinedAt",
          "totalRuns",
          "totalDistance",
          "wishlisted",
          "favorites",
          "strava",
        )
        .get(),
    ]);

    const routes = routesSnap.docs.map((doc) => {
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
        coordinates: compactCoordinates(d.coordinates),
        hasTcx: d.hasTcx ?? false,
        strava: d.strava || null,
      };
    });

    routes.sort((a, b) => new Date(b.date).valueOf() - new Date(a.date).valueOf());

    let profile = null;
    let favorites: string[] = [];

    if (!profileSnap.empty) {
      const profileData = profileSnap.docs[0].data();
      profile = {
        id: profileSnap.docs[0].id,
        username: profileData.username || "",
        displayName: profileData.displayName || "",
        avatar: profileData.avatar || "person",
        joinedAt: profileData.joinedAt || new Date().toISOString(),
        totalRuns: profileData.totalRuns || 0,
        totalDistance: profileData.totalDistance || 0,
        wishlisted: profileData.wishlisted || [],
        favorites: profileData.favorites || [],
        strava: profileData.strava ? {
          athleteId: profileData.strava.athleteId,
          athleteName: profileData.strava.athleteName,
          scope: profileData.strava.scope,
          expiresAt: profileData.strava.expiresAt,
          connectedAt: profileData.strava.connectedAt,
          updatedAt: profileData.strava.updatedAt,
        } : null,
      };
      favorites = profileData.favorites || [];
    }

    return NextResponse.json({ profile, routes, favorites });
  } catch (err) {
    console.error("[user/dashboard]", err);
    return NextResponse.json({ error: "Failed to load dashboard" }, { status: 500 });
  }
}
