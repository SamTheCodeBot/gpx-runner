import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import { verifyFirebaseIdToken } from "@/lib/firebaseAuthServer";
import { refreshStravaToken, stravaGet } from "@/lib/strava";
import type { GPXRoute, RouteMetricSample, UserProfile } from "@/app/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StravaActivity = {
  id: number;
  name?: string;
  distance?: number;
  moving_time?: number;
  elapsed_time?: number;
  total_elevation_gain?: number;
  start_date?: string;
  sport_type?: string;
  type?: string;
};

type StravaStream<T> = {
  data?: T[];
};

type StravaStreams = {
  latlng?: StravaStream<[number, number]>;
  altitude?: StravaStream<number>;
  time?: StravaStream<number>;
  velocity_smooth?: StravaStream<number>;
  heartrate?: StravaStream<number>;
  distance?: StravaStream<number>;
};

type SyncMode = "recent" | "backfill";

type SyncOptions = {
  mode: SyncMode;
  perPage: number;
  maxPages: number;
  targetRuns: number;
  importLimit: number;
};

function syncOptions(mode: SyncMode): SyncOptions {
  if (mode === "backfill") {
    return {
      mode,
      perPage: 100,
      maxPages: 5,
      targetRuns: 100,
      importLimit: 100,
    };
  }

  return {
    mode,
    perPage: 30,
    maxPages: 1,
    targetRuns: 30,
    importLimit: 20,
  };
}

async function getProfileDoc(uid: string) {
  const db = adminDb();
  const snap = await db.collection("userProfiles").where("userId", "==", uid).limit(1).get();
  if (!snap.empty) return snap.docs[0];
  const byId = await db.collection("userProfiles").doc(uid).get();
  return byId.exists ? byId : null;
}

function isRun(activity: StravaActivity): boolean {
  const type = activity.sport_type ?? activity.type;
  return type === "Run" || type === "TrailRun" || type === "VirtualRun";
}

function paceMinPerKm(velocityMetersPerSecond?: number): number | undefined {
  if (!velocityMetersPerSecond || velocityMetersPerSecond <= 0) return undefined;
  return 1000 / velocityMetersPerSecond / 60;
}

function buildSamples(activity: StravaActivity, streams: StravaStreams): RouteMetricSample[] | undefined {
  const latlng = streams.latlng?.data;
  if (!latlng?.length) return undefined;

  const startTime = activity.start_date ? new Date(activity.start_date).valueOf() : null;
  return latlng.map(([lat, lon], index) => {
    const seconds = streams.time?.data?.[index];
    const sample: RouteMetricSample = {
      coordinate: [lon, lat],
    };

    const altitude = streams.altitude?.data?.[index];
    const heartRate = streams.heartrate?.data?.[index];
    const pace = paceMinPerKm(streams.velocity_smooth?.data?.[index]);
    if (typeof altitude === "number") sample.elevation = altitude;
    if (typeof heartRate === "number") sample.heartRate = heartRate;
    if (typeof pace === "number") sample.paceMinPerKm = pace;
    if (startTime !== null && typeof seconds === "number") {
      sample.time = new Date(startTime + seconds * 1000).toISOString();
    }

    return sample;
  });
}

function serializeRoute(route: GPXRoute) {
  const payload: any = {
    ...route,
    coordinates: route.coordinates.map(([lon, lat]) => ({ lat, lon })),
  };

  if (route.samples?.length) {
    payload.samples = route.samples.map((sample) => {
      const serialized: any = {
        coordinate: { lon: sample.coordinate[0], lat: sample.coordinate[1] },
      };
      if (sample.elevation !== undefined) serialized.elevation = sample.elevation;
      if (sample.time !== undefined) serialized.time = sample.time;
      if (sample.heartRate !== undefined) serialized.heartRate = sample.heartRate;
      if (sample.paceMinPerKm !== undefined) serialized.paceMinPerKm = sample.paceMinPerKm;
      return serialized;
    });
  } else {
    delete payload.samples;
  }

  Object.keys(payload).forEach((key) => {
    if (payload[key] === undefined) delete payload[key];
  });

  return payload;
}

function routeFromStrava(activity: StravaActivity, streams: StravaStreams, uid: string): GPXRoute | null {
  const latlng = streams.latlng?.data;
  if (!latlng?.length) return null;

  const coordinates = latlng.map(([lat, lon]) => [lon, lat] as [number, number]);
  const samples = buildSamples(activity, streams);
  const isTrail = (activity.sport_type ?? activity.type) === "TrailRun";

  return {
    id: `strava-${activity.id}`,
    name: activity.name || "Strava run",
    date: activity.start_date ? new Date(activity.start_date).toISOString() : new Date().toISOString(),
    coordinates,
    distance: Math.round(activity.distance ?? streams.distance?.data?.at(-1) ?? 0),
    elevationGain: Math.round(activity.total_elevation_gain ?? 0),
    duration: Math.round(((activity.moving_time ?? activity.elapsed_time ?? 0) / 60) * 10) / 10,
    color: "#fc4c02",
    type: isTrail ? "trail" : "road",
    userId: uid,
    samples,
    strava: {
      activityId: activity.id,
      sportType: activity.sport_type ?? activity.type,
      syncedAt: new Date().toISOString(),
    },
  };
}

async function loadRunActivities(accessToken: string, options: SyncOptions): Promise<StravaActivity[]> {
  const runs: StravaActivity[] = [];

  for (let page = 1; page <= options.maxPages && runs.length < options.targetRuns; page += 1) {
    const activities = await stravaGet<StravaActivity[]>(
      `/athlete/activities?per_page=${options.perPage}&page=${page}`,
      accessToken
    );

    if (!activities.length) break;

    for (const activity of activities) {
      if (isRun(activity)) runs.push(activity);
      if (runs.length >= options.targetRuns) break;
    }
  }

  return runs.slice(0, options.targetRuns);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const mode: SyncMode = body?.mode === "backfill" ? "backfill" : "recent";
    const options = syncOptions(mode);
    const authHeader = req.headers.get("authorization") ?? "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
    if (!idToken) {
      return NextResponse.json({ error: "Missing Firebase auth token" }, { status: 401 });
    }

    const decoded = await verifyFirebaseIdToken(idToken);
    const profileDoc = await getProfileDoc(decoded.uid);
    if (!profileDoc) {
      return NextResponse.json({ error: "Missing user profile" }, { status: 404 });
    }

    const profile = profileDoc.data() as UserProfile;
    const strava = profile.strava;
    if (!strava?.accessToken || !strava.refreshToken) {
      return NextResponse.json({ error: "Strava is not connected" }, { status: 400 });
    }

    let accessToken = strava.accessToken;
    let nextStrava = strava;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (strava.expiresAt <= nowSeconds + 60) {
      const refreshed = await refreshStravaToken(strava.refreshToken);
      accessToken = refreshed.access_token;
      nextStrava = {
        ...strava,
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token,
        expiresAt: refreshed.expires_at,
        updatedAt: new Date().toISOString(),
      };
    }

    const db = adminDb();
    const routeSnap = await db.collection("routes").where("userId", "==", decoded.uid).get();
    const existingActivityIds = new Set<number>();
    let existingDistanceMeters = 0;
    routeSnap.forEach((doc) => {
      const data = doc.data();
      const activityId = data.strava?.activityId;
      if (typeof activityId === "number") existingActivityIds.add(activityId);
      if (typeof data.distance === "number") existingDistanceMeters += data.distance;
    });

    const runActivities = await loadRunActivities(accessToken, options);
    const newRunActivities = runActivities.filter((activity) => !existingActivityIds.has(activity.id));

    const importedRoutes: GPXRoute[] = [];
    const skipped: { id: number; reason: string }[] = [];
    for (const activity of newRunActivities.slice(0, options.importLimit)) {
      const streams = await stravaGet<StravaStreams>(
        `/activities/${activity.id}/streams?keys=time,distance,latlng,altitude,velocity_smooth,heartrate&key_by_type=true`,
        accessToken
      );
      const route = routeFromStrava(activity, streams, decoded.uid);
      if (!route) {
        skipped.push({ id: activity.id, reason: "No GPS stream" });
        continue;
      }

      await db.collection("routes").doc(route.id).set(serializeRoute(route), { merge: true });
      importedRoutes.push(route);
    }

    const importedDistanceKm = importedRoutes.reduce((sum, route) => sum + (route.distance || 0), 0) / 1000;
    await profileDoc.ref.set({
      strava: {
        ...nextStrava,
        lastSyncAt: new Date().toISOString(),
      },
      totalRuns: routeSnap.size + importedRoutes.length,
      totalDistance: Math.round(((existingDistanceMeters / 1000) + importedDistanceKm) * 10) / 10,
    }, { merge: true });

    return NextResponse.json({
      mode,
      imported: importedRoutes.length,
      skipped: skipped.length + runActivities.filter((activity) => existingActivityIds.has(activity.id)).length,
      scanned: runActivities.length,
    });
  } catch (error) {
    console.error("[strava/sync]", error);
    return NextResponse.json({ error: "Failed to sync Strava runs" }, { status: 500 });
  }
}
