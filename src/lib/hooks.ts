"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { collection, query, where, getDocs, getDoc, doc, setDoc, updateDoc, deleteDoc } from "firebase/firestore";
import { ref, uploadBytes, deleteObject } from "firebase/storage";
import { auth as firebaseAuth, db, storage } from "@/lib/firebase";
import { GPXRoute, type CanonicalActivity } from "@/app/types";
import { routeCountryNames, routeHasCountry } from "@/lib/countries";
import { haversine, parseGPXFile, parseTCXFile, nextColor, downloadGPXFile } from "@/lib/utils";
import { mergeActivityRecords, type UnifiedRun } from "@/lib/ingestion/activityMerge";
import { boundTracksNearStart, historyRadiusMeters, toLatLngTrack } from "@/engine/trackHistory";
import type { FamiliarityReport, FamiliarityTarget } from "@/engine/familiarityReport";

const ROUTE_CACHE_VERSION = 3;
const ROUTE_CACHE_TTL_MS = 15 * 60 * 1000;
const ROUTE_CACHE_MAX_BYTES = 4_500_000;

export interface RouteFilter {
  year?: string;
  month?: string;
  type?: string;
  country?: string;
  minDistance?: number;
  maxDistance?: number;
}

export interface RouteStats {
  totalRuns: number;
  totalDistance: number;
  totalElevation: number;
  totalTime: number;
}

export type RouteSummary = Pick<
  GPXRoute,
  | "id"
  | "name"
  | "date"
  | "distance"
  | "elevationGain"
  | "duration"
  | "color"
  | "userId"
  | "type"
  | "isRoundTrip"
  | "countries"
  | "hasTcx"
  | "strava"
> & {
  coordinates: [number, number][];
};

interface RouteCachePayload {
  version: number;
  userId: string;
  cachedAt: number;
  routes: GPXRoute[];
}

interface RouteSummaryCachePayload {
  version: number;
  userId: string;
  cachedAt: number;
  routes: RouteSummary[];
}

function routeCacheKey(userId: string) {
  return `gpx-routes:${ROUTE_CACHE_VERSION}:${userId}`;
}

function routeSummaryCacheKey(userId: string) {
  return `gpx-route-summaries:${ROUTE_CACHE_VERSION}:${userId}`;
}

function isFreshCache(cachedAt: number) {
  return Date.now() - cachedAt < ROUTE_CACHE_TTL_MS;
}

function routeCountriesFromData(data: any, coordinates: [number, number][] = []): string[] | undefined {
  if (Array.isArray(data?.countries) && data.countries.length > 0) {
    const countries = data.countries.filter((country: unknown): country is string => typeof country === "string");
    return Array.from(new Set<string>(countries)).sort((a, b) => a.localeCompare(b));
  }
  if (!coordinates.length) return undefined;
  return routeCountryNames({ coordinates });
}

function summarizeRoute(route: GPXRoute): RouteSummary {
  return {
    id: route.id,
    name: route.name,
    date: route.date,
    distance: route.distance,
    elevationGain: route.elevationGain,
    duration: route.duration,
    color: route.color,
    userId: route.userId,
    type: route.type,
    isRoundTrip: route.isRoundTrip,
    countries: route.countries?.length ? route.countries : routeCountryNames(route),
    hasTcx: route.hasTcx,
    strava: route.strava,
    coordinates: [],
  };
}

function deserializeRouteSummary(id: string, data: any): RouteSummary {
  const rawCoordinates: Array<{ lat: number; lon: number }> = Array.isArray(data.coordinates) ? data.coordinates : [];
  const countryStep = rawCoordinates.length > 25 ? Math.ceil(rawCoordinates.length / 25) : 1;
  const countryCoordinates = rawCoordinates
    .filter((_coordinate, index) => index === 0 || index === rawCoordinates.length - 1 || index % countryStep === 0)
    .map((c: { lat: number; lon: number }) => [c.lon, c.lat] as [number, number]);

  return {
    id,
    name: data.name || "Untitled route",
    date: data.date || new Date(0).toISOString(),
    distance: typeof data.distance === "number" ? data.distance : 0,
    elevationGain: typeof data.elevationGain === "number" ? data.elevationGain : 0,
    duration: data.duration,
    color: data.color || "#fc4c02",
    userId: data.userId,
    type: data.type,
    isRoundTrip: data.isRoundTrip,
    countries: routeCountriesFromData(data, countryCoordinates),
    hasTcx: data.hasTcx,
    strava: data.strava,
    coordinates: [],
  };
}

export function useGPXRoutes(userId: string | null, options: { loadRoutes?: boolean } = {}) {
  const loadRoutes = options.loadRoutes ?? true;
  const isStorageObjectNotFound = (error: unknown) => {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
    const message = error instanceof Error ? error.message : "";
    return code === "storage/object-not-found" || message.includes("does not exist");
  };

  const stripRouteCache = useCallback((route: GPXRoute): GPXRoute => ({
    ...route,
    samples: undefined,
  }), []);

  const compactRouteCache = useCallback((route: GPXRoute): GPXRoute => {
    const maxCoordinates = 500;
    const compactSamples = route.samples?.length
      ? route.samples.filter((_, index) => {
          const maxSamples = 250;
          const step = Math.ceil((route.samples?.length || 0) / maxSamples);
          return index === 0 || index === (route.samples?.length || 1) - 1 || index % step === 0;
        })
      : undefined;
    const routeWithCompactSamples = { ...route, samples: compactSamples };

    if (route.coordinates.length <= maxCoordinates) return routeWithCompactSamples;

    const step = Math.ceil(route.coordinates.length / maxCoordinates);
    return {
      ...route,
      samples: compactSamples,
      coordinates: route.coordinates.filter((_, index) => (
        index === 0 || index === route.coordinates.length - 1 || index % step === 0
      )),
    };
  }, []);

  const cacheRoutes = useCallback((routesToCache: GPXRoute[], cacheUserId = userId) => {
    if (!cacheUserId) return;
    try {
      const summaries: RouteSummaryCachePayload = {
        version: ROUTE_CACHE_VERSION,
        userId: cacheUserId,
        cachedAt: Date.now(),
        routes: routesToCache.map(summarizeRoute),
      };
      localStorage.setItem(routeSummaryCacheKey(cacheUserId), JSON.stringify(summaries));

      const fullPayload = (routes: GPXRoute[]): RouteCachePayload => ({
        version: ROUTE_CACHE_VERSION,
        userId: cacheUserId,
        cachedAt: Date.now(),
        routes,
      });

      let payload = JSON.stringify(fullPayload(routesToCache.map(compactRouteCache)));
      if (payload.length > ROUTE_CACHE_MAX_BYTES) {
        payload = JSON.stringify(fullPayload(routesToCache.map(stripRouteCache)));
      }
      if (payload.length > ROUTE_CACHE_MAX_BYTES) {
        payload = JSON.stringify(fullPayload(routesToCache.slice(0, 75).map(compactRouteCache)));
      }
      if (payload.length > ROUTE_CACHE_MAX_BYTES) {
        localStorage.removeItem(routeCacheKey(cacheUserId));
        return;
      }
      localStorage.setItem(routeCacheKey(cacheUserId), payload);
    } catch (e) {
      localStorage.removeItem(routeCacheKey(cacheUserId));
    }
  }, [compactRouteCache, stripRouteCache, userId]);

  const serializeRoute = useCallback((route: GPXRoute) => {
    const payload: any = {
      ...route,
      countries: route.countries?.length ? route.countries : routeCountryNames(route),
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
  }, []);

  const deserializeRoute = useCallback((id: string, data: any): GPXRoute => {
    const rawCoordinates: Array<{ lat: number; lon: number }> = Array.isArray(data.coordinates) ? data.coordinates : [];
    const coordinates = rawCoordinates.map((c) => [c.lon, c.lat] as [number, number]);
    const countryStep = rawCoordinates.length > 25 ? Math.ceil(rawCoordinates.length / 25) : 1;
    const countryCoordinates = rawCoordinates
      .filter((_coordinate, index) => index === 0 || index === rawCoordinates.length - 1 || index % countryStep === 0)
      .map((c) => [c.lon, c.lat] as [number, number]);

    return {
      ...data,
      id,
      coordinates,
      countries: routeCountriesFromData(data, countryCoordinates),
      samples: Array.isArray(data.samples)
        ? data.samples.map((sample: any) => ({
            ...sample,
            coordinate: Array.isArray(sample.coordinate)
              ? sample.coordinate
              : [sample.coordinate.lon, sample.coordinate.lat],
          }))
        : undefined,
    } as GPXRoute;
  }, []);

  const mergeMetricSamples = useCallback((parsed: ReturnType<typeof parseGPXFile>, tcxText?: string): GPXRoute["samples"] => {
    const samples = parsed.samples.map((sample) => ({
      coordinate: sample.coordinate,
      elevation: sample.elevation,
      time: sample.time,
    }));

    const downsample = (metricSamples: NonNullable<GPXRoute["samples"]>) => {
      const maxSamples = 900;
      if (metricSamples.length <= maxSamples) return metricSamples;
      const step = Math.ceil(metricSamples.length / maxSamples);
      return metricSamples.filter((_, index) => index % step === 0 || index === metricSamples.length - 1);
    };

    if (!tcxText) return downsample(samples);

    const tcxSamples = parseTCXFile(tcxText);
    if (!tcxSamples.length) return samples;

    return downsample(samples.map((sample) => {
      let best = tcxSamples[0];
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const tcxSample of tcxSamples) {
        const distance = haversine(sample.coordinate[1], sample.coordinate[0], tcxSample.coordinate[1], tcxSample.coordinate[0]);
        if (distance < bestDistance) {
          best = tcxSample;
          bestDistance = distance;
        }
      }

      if (bestDistance > 250) return sample;

      return {
        ...sample,
        elevation: sample.elevation ?? best.elevation,
        heartRate: best.heartRate,
        paceMinPerKm: best.paceMinPerKm,
      };
    }));
  }, []);

  const [routes, setRoutes] = useState<GPXRoute[]>([]);
  const [loading, setLoading] = useState(false);

  // Sync from Firestore when user is available. A fresh per-user local cache
  // avoids expensive repeat loads while preventing cross-account route leaks.
  useEffect(() => {
    if (!loadRoutes) return;
    if (!userId) {
      setRoutes([]);
      return;
    }

    let cancelled = false;
    let hasFreshCache = false;

    try {
      const stored = localStorage.getItem(routeCacheKey(userId));
      if (stored) {
        const parsed = JSON.parse(stored) as RouteCachePayload;
        if (parsed.version === ROUTE_CACHE_VERSION && parsed.userId === userId && Array.isArray(parsed.routes)) {
          setRoutes(parsed.routes);
          hasFreshCache = isFreshCache(parsed.cachedAt);
        }
      }
    } catch {}

    const load = async () => {
      if (!db) return;
      try {
        if (!hasFreshCache) setLoading(true);
        const q = query(collection(db, "routes"), where("userId", "==", userId));
        const snap = await getDocs(q);
        const firestoreRoutes: GPXRoute[] = [];
        snap.forEach((d) => {
          const data = d.data();
          if (data.coordinates && Array.isArray(data.coordinates)) {
            firestoreRoutes.push(deserializeRoute(d.id, data));
          }
        });
        firestoreRoutes.sort((a, b) => new Date(b.date).valueOf() - new Date(a.date).valueOf());
        if (cancelled) return;
        setRoutes(firestoreRoutes);
        cacheRoutes(firestoreRoutes, userId);
      } catch (e) {
        console.error("Firestore load error", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    if (!hasFreshCache) load();
    return () => {
      cancelled = true;
    };
  }, [userId, deserializeRoute, cacheRoutes, loadRoutes]);

  const saveRoutes = useCallback((newRoutes: GPXRoute[]) => {
    cacheRoutes(newRoutes);
    setRoutes(newRoutes);
  }, [cacheRoutes]);

  const uploadFiles = useCallback(
    async (files: File[], currentRoutes: GPXRoute[], tcxFiles: File[] = []): Promise<GPXRoute[]> => {
      setLoading(true);
      const newRoutes: GPXRoute[] = [];
      try {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const id = `route-${Date.now()}-${i}`;
          const text = await file.text();
          const tcxText = tcxFiles[i] ? await tcxFiles[i].text() : undefined;
          const parsed = parseGPXFile(text, file.name.replace(".gpx", ""));

          // Check for duplicates
          const isDup = currentRoutes.some(
            (r) => r.name === parsed.name && r.date === parsed.date
          );
          if (isDup) {
            const ok = confirm(`"${parsed.name}" already exists. Add anyway?`);
            if (!ok) continue;
          }

          const route: GPXRoute = {
            id,
            name: parsed.name,
            date: parsed.date,
            coordinates: parsed.coordinates,
            distance: parsed.distance,
            elevationGain: parsed.elevationGain,
            samples: mergeMetricSamples(parsed, tcxText),
            hasTcx: Boolean(tcxText),
            color: nextColor(),
            type: "road" as const,
            userId: userId || undefined,
          };

          // Upload GPX/TCX to Firebase Storage
          if (storage && userId) {
            try {
              await uploadBytes(ref(storage, `gpx-files/${userId}/${id}.gpx`), file);
              if (tcxFiles[i]) {
                await uploadBytes(ref(storage, `gpx-files/${userId}/${id}.tcx`), tcxFiles[i]);
              }
            } catch (e) {
              console.error("Storage upload error", e);
            }
          }

          // Save to Firestore
          if (db && userId) {
            try {
              await setDoc(doc(db, "routes", id), {
                ...serializeRoute(route),
              });
            } catch (e) {
              console.error("Firestore save error", e);
            }
          }

          newRoutes.push(route);
        }
        return newRoutes;
      } finally {
        setLoading(false);
      }
    },
    [userId, mergeMetricSamples, serializeRoute]
  );

  const deleteRoute = useCallback(
    async (id: string, currentRoutes: GPXRoute[]) => {
      const updated = currentRoutes.filter((r) => r.id !== id);
      saveRoutes(updated);
      if (storage && userId) {
        await Promise.all([
          deleteObject(ref(storage, `gpx-files/${userId}/${id}.gpx`)).catch((e) => {
            if (isStorageObjectNotFound(e)) return;
            console.error("Failed to delete GPX from Firebase Storage", e);
          }),
          deleteObject(ref(storage, `gpx-files/${userId}/${id}.tcx`)).catch((e) => {
            if (isStorageObjectNotFound(e)) return;
            console.error("Failed to delete TCX from Firebase Storage", e);
          }),
        ]);
      }
      if (db) {
        try {
          const { deleteDoc } = await import("firebase/firestore");
          await deleteDoc(doc(db, "routes", id));
        } catch (e) {
          console.error("Failed to delete from Firestore", e);
        }
      }
    },
    [saveRoutes, userId]
  );

  const updateRoute = useCallback(
    async (id: string, name: string, type: string, currentRoutes: GPXRoute[]) => {
      const route = currentRoutes.find((r) => r.id === id);

      const updateIds = route
        ? currentRoutes
            .filter((r) => r.name === route.name && r.date === route.date)
            .map((r) => r.id)
        : [id];

      const updated = currentRoutes.map((r) =>
        updateIds.includes(r.id) ? { ...r, name, type: type as "road" | "trail" | "mixed" | undefined } : r
      );
      saveRoutes(updated);

      if (db) {
        try {
          const { updateDoc } = await import("firebase/firestore");
          for (const did of updateIds) {
            await updateDoc(doc(db, "routes", did), { name, type });
          }
        } catch (e) {
          console.error("Firestore update error", e);
        }
      }
    },
    [saveRoutes]
  );

  return { routes, saveRoutes, uploadFiles, deleteRoute, updateRoute, loading };
}

// ─── useSyncedActivities / useUnifiedRoutes ───────────────────────────────────

/**
 * Collection name repeated rather than imported from `src/lib/ingestion/store.ts`.
 * That module imports `firebase-admin`; importing it from a client hook would
 * drag the Admin SDK into the browser bundle.
 */
const ACTIVITY_COLLECTION = "activities";
const ACTIVITY_CACHE_VERSION = 1;

/**
 * Firebase resolves auth AFTER the first render, so a hook that returns early
 * on a null uid can load nothing and never retry — the bug this codebase has
 * already been bitten by. `userId` is threaded down from `useAuth`, which means
 * it is null on the first pass; rather than give up, fall back to reading
 * `auth.currentUser` directly and poll until Firebase has an answer. Bounded,
 * so a genuinely signed-out visitor settles instead of polling forever.
 */
const ACTIVITY_AUTH_POLL_MS = 250;
const ACTIVITY_AUTH_MAX_POLLS = 20;

interface ActivityCachePayload {
  version: number;
  userId: string;
  cachedAt: number;
  activities: CanonicalActivity[];
}

function activityCacheKey(userId: string) {
  return `gpx-activities:${ACTIVITY_CACHE_VERSION}:${userId}`;
}

function deserializeActivity(id: string, data: any): CanonicalActivity | null {
  // Only the fields the read layer actually relies on are checked. An activity
  // with no start time cannot be placed on a timeline or matched to anything.
  if (!data || typeof data.startedAt !== "string" || typeof data.source !== "string") return null;
  return {
    ...data,
    id,
    distanceMeters: typeof data.distanceMeters === "number" ? data.distanceMeters : 0,
  } as CanonicalActivity;
}

/**
 * Canonical activity records for the signed-in owner.
 *
 * Read-only by design: `firestore.rules` grants clients read on their own
 * `activities` and no write anywhere, because ingestion, consent and erasure
 * must go through the audited API routes. These documents hold no geometry, so
 * the payload is small even over a long history.
 */
export function useSyncedActivities(userId: string | null) {
  const [activities, setActivities] = useState<CanonicalActivity[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let hasFreshCache = false;

    if (userId) {
      try {
        const stored = localStorage.getItem(activityCacheKey(userId));
        if (stored) {
          const parsed = JSON.parse(stored) as ActivityCachePayload;
          if (parsed.version === ACTIVITY_CACHE_VERSION && parsed.userId === userId && Array.isArray(parsed.activities)) {
            setActivities(parsed.activities);
            hasFreshCache = isFreshCache(parsed.cachedAt);
          }
        }
      } catch {}
    }

    const load = async (uid: string) => {
      if (!db) return;
      try {
        if (!hasFreshCache) setLoading(true);
        // Single equality filter: served by the automatic single-field index,
        // so no composite index has to be deployed for this to work.
        const snap = await getDocs(query(collection(db, ACTIVITY_COLLECTION), where("ownerUid", "==", uid)));
        const loaded: CanonicalActivity[] = [];
        snap.forEach((d) => {
          const activity = deserializeActivity(d.id, d.data());
          if (activity) loaded.push(activity);
        });
        if (cancelled) return;
        setActivities(loaded);
        try {
          const payload: ActivityCachePayload = {
            version: ACTIVITY_CACHE_VERSION,
            userId: uid,
            cachedAt: Date.now(),
            activities: loaded,
          };
          localStorage.setItem(activityCacheKey(uid), JSON.stringify(payload));
        } catch {
          localStorage.removeItem(activityCacheKey(uid));
        }
      } catch (e) {
        // An owner who has connected no provider simply has none of these. The
        // unified list degrades to the routes collection alone rather than
        // breaking the page.
        console.error("[useSyncedActivities] load", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    const resolveUid = () => {
      if (cancelled) return;
      const uid = userId ?? firebaseAuth?.currentUser?.uid ?? null;
      if (uid) {
        load(uid);
        return;
      }

      attempts += 1;
      if (attempts > ACTIVITY_AUTH_MAX_POLLS) {
        // Genuinely signed out, not merely early: drop anything held.
        setActivities([]);
        setLoading(false);
        return;
      }
      timer = setTimeout(resolveUid, ACTIVITY_AUTH_POLL_MS);
    };

    if (!hasFreshCache) resolveUid();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [userId]);

  return { activities, loading };
}

/**
 * THE unified read layer: the owner's manually uploaded routes and their
 * provider-synced activities as one chronologically sorted list.
 *
 * Takes `routes` from `useGPXRoutes` rather than re-querying them, so a page
 * keeps exactly one copy of its route state and every existing mutation
 * (upload, rename, delete) goes on working untouched. The returned items are
 * `GPXRoute`s with provenance attached, so the map, filters, stats and badge
 * rules consume them unchanged.
 *
 * Nothing here writes to Firestore. Duplicate runs are collapsed for display
 * only — see `activityMerge.ts`.
 */
export function useUnifiedRoutes(userId: string | null, routes: GPXRoute[]) {
  const { activities, loading } = useSyncedActivities(userId);

  const unified = useMemo<UnifiedRun[]>(
    () => mergeActivityRecords({ routes, activities }),
    [routes, activities],
  );

  return { routes: unified, activities, loading };
}

export function useRouteSummaries(userId: string | null) {
  const [routes, setRoutes] = useState<RouteSummary[]>([]);
  const [loading, setLoading] = useState(false);

  const cacheSummaries = useCallback((summaries: RouteSummary[], cacheUserId = userId) => {
    if (!cacheUserId) return;
    try {
      const payload: RouteSummaryCachePayload = {
        version: ROUTE_CACHE_VERSION,
        userId: cacheUserId,
        cachedAt: Date.now(),
        routes: summaries,
      };
      localStorage.setItem(routeSummaryCacheKey(cacheUserId), JSON.stringify(payload));
    } catch {
      localStorage.removeItem(routeSummaryCacheKey(cacheUserId));
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      setRoutes([]);
      return;
    }

    let cancelled = false;
    let hasFreshCache = false;

    try {
      const stored = localStorage.getItem(routeSummaryCacheKey(userId));
      if (stored) {
        const parsed = JSON.parse(stored) as RouteSummaryCachePayload;
        if (parsed.version === ROUTE_CACHE_VERSION && parsed.userId === userId && Array.isArray(parsed.routes)) {
          setRoutes(parsed.routes);
          hasFreshCache = isFreshCache(parsed.cachedAt);
        }
      }
    } catch {}

    const load = async () => {
      const user = firebaseAuth?.currentUser;
      if (!user) return;
      if (!hasFreshCache) setLoading(true);
      try {
        const idToken = await user.getIdToken();
        const res = await fetch("/api/routes/summaries", {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        if (!res.ok) throw new Error(`Route summary fetch failed: ${res.status}`);
        const data = await res.json();
        const summaries: RouteSummary[] = Array.isArray(data.routes)
          ? data.routes.map((route: RouteSummary) => ({ ...route, coordinates: route.coordinates ?? [] }))
          : [];
        summaries.sort((a, b) => new Date(b.date).valueOf() - new Date(a.date).valueOf());
        if (cancelled) return;
        setRoutes(summaries);
        cacheSummaries(summaries, userId);
      } catch (e) {
        console.error("Route summary load error", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    if (!hasFreshCache) load();
    return () => {
      cancelled = true;
    };
  }, [userId, cacheSummaries]);

  return { routes, loading };
}

export function useRouteStats(routes: GPXRoute[]) {
  const [stats, setStats] = useState<RouteStats | null>(null);

  useEffect(() => {
    if (routes.length === 0) {
      setStats(null);
      return;
    }
    let totalDistance = 0;
    let totalElevation = 0;
    let totalTime = 0;
    routes.forEach((r) => {
      totalDistance += r.distance || 0;
      totalElevation += r.elevationGain || 0;
      if (r.duration) totalTime += r.duration;
    });
    setStats({
      totalRuns: routes.length,
      totalDistance: Math.round((totalDistance / 1000) * 10) / 10,
      totalElevation: Math.round(totalElevation),
      totalTime,
    });
  }, [routes]);

  return stats;
}

/**
 * Generic in the item type so the unified read layer's provenance survives the
 * filter. A plain `GPXRoute[]` caller still infers `GPXRoute[]` exactly as before.
 */
export function useRouteFilter<T extends GPXRoute>(
  routes: T[],
  baseFilter: RouteFilter,
  searchQuery: string
): T[] {
  const [filtered, setFiltered] = useState<T[]>(routes);

  useEffect(() => {
    let out = [...routes];
    if (baseFilter.year) out = out.filter((r) => r.date.startsWith(baseFilter.year!));
    if (baseFilter.month) out = out.filter((r) => r.date.substring(5, 7) === baseFilter.month);
    if (baseFilter.minDistance !== undefined)
      out = out.filter((r) => r.distance / 1000 >= baseFilter.minDistance!);
    if (baseFilter.maxDistance !== undefined)
      out = out.filter((r) => r.distance / 1000 <= baseFilter.maxDistance!);
    if (baseFilter.type && baseFilter.type !== "all")
      out = out.filter((r) => r.type === baseFilter.type);
    if (baseFilter.country)
      out = out.filter((r) => routeHasCountry(r, baseFilter.country!));
    if (searchQuery)
      out = out.filter((r) => r.name.toLowerCase().includes(searchQuery.toLowerCase()));
    setFiltered(out);
  }, [routes, baseFilter, searchQuery]);

  return filtered;
}

/** How the suggested route is shaped, when that is not what the runner asked for. */
export type RouteShapeNotice = {
  isOutAndBack: boolean;
  /** Plain-language sentence for the UI, or null when nothing needs saying. */
  notice: string | null;
};

type RouteSuggestionOptions = {
  routeType?: "road" | "trail" | "mixed";
  preferQuiet?: boolean;
  preferGreen?: boolean;
  elevationPreference?: "any" | "hilly" | "flat";
  directionShift?: number;
};

/** Client-side budget for the history we post. The server enforces its own. */
const SUGGESTION_TRACK_BUDGET = {
  maxTracks: 150,
  maxPointsPerTrack: 500,
  maxTotalPoints: 25_000,
};

export function useRouteSuggestions(
  suggestDistance: number,
  familiarity: FamiliarityTarget | boolean = "mixed",
) {
  const familiarityTarget: FamiliarityTarget =
    typeof familiarity === "boolean" ? (familiarity ? "unfamiliar" : "mixed") : familiarity;
  const [suggestedRoute, setSuggestedRoute] = useState<GPXRoute | null>(null);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [suggestionFamiliarity, setSuggestionFamiliarity] = useState<FamiliarityReport | null>(null);
  /**
   * Set when the server could not find a loop and fell back to a there-and-back.
   * The runner should never have to work that out from the map themselves.
   */
  const [suggestionShape, setSuggestionShape] = useState<RouteShapeNotice | null>(null);

  const getSuggestion = useCallback(
    async (
      startPoint: [number, number] | null,
      routes: GPXRoute[],
      options: RouteSuggestionOptions = {}
    ) => {
      setIsSuggesting(true);
      setSuggestionError(null);
      setSuggestionFamiliarity(null);
      setSuggestionShape(null);
      try {
        let lat = 56.9; // Falkenberg
        let lon = 12.5;
        if (startPoint) { [lon, lat] = startPoint; }
        else if (routes.length > 0) {
          const allCoords = routes.flatMap((r) => r.coordinates);
          if (allCoords.length > 0) {
            lat = allCoords.reduce((s, c) => s + c[1], 0) / allCoords.length;
            lon = allCoords.reduce((s, c) => s + c[0], 0) / allCoords.length;
          }
        }

        // Familiarity is measured against the runner's own tracks, so they have
        // to reach the server. Only the ground within reach of the start can
        // overlap the loop, and it is thinned before it goes on the wire — a
        // full activity history would be megabytes.
        const start = { lat, lng: lon };
        const tracks = boundTracksNearStart(
          routes.map((route) => toLatLngTrack(route.coordinates)),
          start,
          { radiusMeters: historyRadiusMeters(suggestDistance), ...SUGGESTION_TRACK_BUDGET },
        ).map((track) => track.map((point) => [point.lng, point.lat] as [number, number]));

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(new Error("Route generation timed out")), 90000);

        const generateFromServer = async () => {
          const response = await fetch("/api/routes/suggest", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              distance: suggestDistance,
              familiarityMode: familiarityTarget,
              tracks,
              centerLat: lat,
              centerLon: lon,
              routeStyle: options.routeType ?? "mixed",
              preferQuiet: options.preferQuiet ?? false,
              preferGreen: options.preferGreen ?? false,
              elevationPreference: options.elevationPreference ?? "any",
              directionShift: options.directionShift ?? 0,
            }),
            signal: controller.signal,
          });

          const data = await response.json().catch(() => null);
          if (!response.ok) {
            throw new Error(data?.error || "No runnable route found for those settings");
          }
          return {
            name: data.name || "Suggested loop",
            coordinates: data.coordinates,
            distance: data.distance,
            elevationGain: data.elevationGain || 0,
            samples: Array.isArray(data.samples) ? data.samples : undefined,
            type: data.type || "mixed",
            familiarity: (data.familiarity ?? null) as FamiliarityReport | null,
            shape: {
              isOutAndBack: Boolean(data.isOutAndBack),
              notice: typeof data.notice === "string" ? data.notice : null,
            },
            isRoundTrip: data.isRoundTrip !== false,
          };
        };

        let result: {
          name: string;
          coordinates: [number, number][];
          distance: number;
          elevationGain: number;
          samples?: GPXRoute["samples"];
          type: "road" | "trail" | "mixed";
          familiarity: FamiliarityReport | null;
          shape: RouteShapeNotice;
          isRoundTrip: boolean;
        } | null = null;

        try {
          result = await generateFromServer();

          if (result) {
            setSuggestionFamiliarity(result.familiarity);
            setSuggestionShape(result.shape);
            setSuggestedRoute({
              id: `suggested-${Date.now()}`,
              name: result.name,
              date: new Date().toISOString(),
              coordinates: result.coordinates,
              distance: result.distance,
              elevationGain: result.elevationGain,
              samples: result.samples,
              color: "#f472b6",
              isRoundTrip: result.isRoundTrip,
              type: result.type,
            });
          }
        } finally {
          clearTimeout(timeout);
        }
      } catch (err) {
        console.error("[useRouteSuggestions]", err);
        setSuggestedRoute(null);
        setSuggestionFamiliarity(null);
        setSuggestionShape(null);
        setSuggestionError(err instanceof Error ? err.message : "Could not generate a runnable route");
      } finally {
        setIsSuggesting(false);
      }
    },
    [suggestDistance, familiarityTarget]
  );

  return {
    suggestedRoute,
    isSuggesting,
    suggestionError,
    /** Always present for a successful suggestion: how much of it the runner has run before. */
    suggestionFamiliarity,
    /** Whether they were given a loop or, failing that, a there-and-back. */
    suggestionShape,
    getSuggestion,
    clearSuggestion: () => {
      setSuggestedRoute(null);
      setSuggestionError(null);
      setSuggestionFamiliarity(null);
      setSuggestionShape(null);
    },
  };
}
// ─── useUserProfile ────────────────────────────────────────────────────────────

export function useUserProfile(userId: string | null) {
  const [profile, setProfile] = useState<import("@/app/types").UserProfile | null>(null);
  const [loading, setLoading] = useState(true); // start true so skeleton shows until confirmed

  const loadProfile = useCallback(async () => {
    if (!db || !userId) return;
    try {
      const direct = await getDoc(doc(db, "userProfiles", userId));
      if (direct.exists()) {
        setProfile(direct.data() as import("@/app/types").UserProfile);
        return;
      }
      const snap = await getDocs(query(collection(db, "userProfiles"), where("userId", "==", userId)));
      if (!snap.empty) {
        setProfile(snap.docs[0].data() as import("@/app/types").UserProfile);
      }
    } catch (e) { console.error("loadProfile", e); }
    finally { setLoading(false); } // always exit loading state after attempt
  }, [userId]);

  useEffect(() => { loadProfile(); }, [loadProfile]);

  const saveProfile = useCallback(async (data: Partial<import("@/app/types").UserProfile>) => {
    const { auth } = await import("@/lib/firebase");
    const currentUid = auth?.currentUser?.uid;
    if (!db || !currentUid) {
      console.error("[saveProfile] no uid — auth state:", auth?.currentUser?.uid);
      return;
    }
    setLoading(true);
    try {
      // Check for duplicate displayName (single-field query, no composite index needed)
      if (data.displayName) {
        const nameSnap = await getDocs(
          query(collection(db, "userProfiles"), where("displayName", "==", data.displayName))
        );
        const duplicate = nameSnap.docs.find(d => d.data().userId !== currentUid);
        if (duplicate) {
          throw new Error("DUPLICATE_NAME");
        }
      }
      const snap = await getDocs(query(collection(db, "userProfiles"), where("userId", "==", currentUid)));
      const isNew = snap.empty;
      const base: import("@/app/types").UserProfile = isNew
        ? { username: "", displayName: "", avatar: "directions_run", joinedAt: new Date().toISOString(), totalRuns: 0, totalDistance: 0 }
        : (snap.docs[0].data() as import("@/app/types").UserProfile);
      const updated = { ...base, ...data, userId: currentUid } as import("@/app/types").UserProfile;
      if (isNew) {
        await setDoc(doc(collection(db, "userProfiles"), currentUid), updated);
      } else {
        await updateDoc(doc(db, "userProfiles", snap.docs[0].id), updated);
      }
      (setProfile as (v: import("@/app/types").UserProfile | null) => void)(updated);
    } catch (e) { console.error("[useUserProfile] save failed", e); throw e; }
    finally { setLoading(false); }
  }, []); // no deps — reads currentUid dynamically from auth.currentUser

  return { profile, saveProfile, loading };
}

// ─── useAccountDeletion ────────────────────────────────────────────────────────

export function useAccountDeletion() {
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError]           = useState("");

  const deleteAccount = useCallback(async (userId: string, password: string) => {
    setIsDeleting(true);
    setError("");
    try {
      const { auth } = await import("@/lib/firebase");
      const {
        reauthenticateWithCredential,
        deleteUser,
        EmailAuthProvider,
      } = await import("firebase/auth");

      const currentUser = auth?.currentUser;
      if (!currentUser || !currentUser.email) throw new Error("Not signed in.");

      // Step 1: Re-authenticate (Firebase requires recent auth before delete)
      const credential = EmailAuthProvider.credential(currentUser.email, password);
      await reauthenticateWithCredential(currentUser, credential);

      // Step 2: Orphan all routes — change userId so they belong to "a runner"
      if (db) {
        const routeSnap = await getDocs(
          query(collection(db, "routes"), where("userId", "==", userId))
        );
        await Promise.all(
          routeSnap.docs.map(doc =>
            updateDoc(doc.ref, { userId: "deleted" })
          )
        );
      }

      // Step 3: Delete all GPX files from Storage
      if (storage) {
        const { listAll, deleteObject: delRef } = await import("firebase/storage");
        try {
          const listRef = ref(storage, `gpx-files/${userId}`);
          const listResult = await listAll(listRef);
          await Promise.all(listResult.items.map(item => delRef(item)));
        } catch {
          // Storage path may not exist — skip
        }
      }

      // Step 4: Delete Firestore user profile document
      if (db) {
        const profileSnap = await getDocs(
          query(collection(db, "userProfiles"), where("userId", "==", userId))
        );
        await Promise.all(profileSnap.docs.map(d => deleteDoc(d.ref)));
      }

      // Step 4b: Ensure a "shadow user" profile exists for orphaned routes
      if (db) {
        const { getDocs: gD, query: q, collection: c, where: w, setDoc: sD, doc: d } = await import("firebase/firestore");
        const shadowSnap = await gD(q(c(db, "userProfiles"), w("userId", "==", "deleted")));
        if (shadowSnap.empty) {
          await sD(d(db, "userProfiles", "deleted"), {
            username: "deleted",
            displayName: "Deleted runner",
            avatar: "person_off",
            joinedAt: new Date(2000, 0, 1).toISOString(),
            totalRuns: 0,
            totalDistance: 0,
            userId: "deleted",
          });
        }
      }

      // Step 5: Delete Firebase Auth account
      await deleteUser(currentUser);

      // Step 6: Redirect (auth state is cleared after deleteUser; signOut is not needed)
      window.location.href = "/";
    } catch (e: any) {
      console.error("[deleteAccount]", e);
      if (e?.code === "auth/wrong-password" || e?.message?.includes("wrong-password")) {
        setError("Incorrect password. Please try again.");
      } else if (e?.code === "auth/requires-recent-login") {
        setError("Please log out and log back in before deleting your account.");
      } else {
        setError(e?.message || "Failed to delete account. Please try again.");
      }
      setIsDeleting(false);
    }
  }, []);

  return { deleteAccount, isDeleting, error };
}

// ─── useWishlist ───────────────────────────────────────────────────────────────

export function useWishlist(userId: string | null) {
  const [wishlist, setWishlist] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  // Load wishlist from Firestore on mount or when userId changes
  useEffect(() => {
    if (!userId) return;
    const load = async () => {
      if (!db) return;
      try {
        const snap = await getDocs(query(collection(db, "userProfiles"), where("userId", "==", userId)));
        if (!snap.empty) {
          const data = snap.docs[0].data();
          setWishlist(data.wishlisted || []);
        }
      } catch (e) { console.error("[useWishlist] load", e); }
    };
    load();
  }, [userId]);

  const addToWishlist = useCallback(async (routeId: string) => {
    if (!db || !userId) return;
    setLoading(true);
    try {
      const snap = await getDocs(query(collection(db, "userProfiles"), where("userId", "==", userId)));
      if (snap.empty) return;
      const docId = snap.docs[0].id;
      const updated = [...wishlist, routeId];
      await updateDoc(doc(db, "userProfiles", docId), { wishlisted: updated });
      setWishlist(updated);
    } catch (e) { console.error("[useWishlist] add", e); }
    finally { setLoading(false); }
  }, [userId, wishlist]);

  const removeFromWishlist = useCallback(async (routeId: string) => {
    if (!db || !userId) return;
    setLoading(true);
    try {
      const snap = await getDocs(query(collection(db, "userProfiles"), where("userId", "==", userId)));
      if (snap.empty) return;
      const docId = snap.docs[0].id;
      const updated = wishlist.filter(id => id !== routeId);
      await updateDoc(doc(db, "userProfiles", docId), { wishlisted: updated });
      setWishlist(updated);
    } catch (e) { console.error("[useWishlist] remove", e); }
    finally { setLoading(false); }
  }, [userId, wishlist]);

  const toggleWishlist = useCallback(async (routeId: string) => {
    if (wishlist.includes(routeId)) {
      await removeFromWishlist(routeId);
    } else {
      await addToWishlist(routeId);
    }
  }, [wishlist, addToWishlist, removeFromWishlist]);

  return { wishlist, toggleWishlist, loading };
}

// ─── useFavorites ──────────────────────────────────────────────────────────────

export function useFavorites(userId: string | null) {
  const [favorites, setFavorites] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!userId) return;
    const load = async () => {
      if (!db) return;
      try {
        const snap = await getDocs(query(collection(db, "userProfiles"), where("userId", "==", userId)));
        if (!snap.empty) {
          const data = snap.docs[0].data();
          setFavorites(data.favorites || []);
        }
      } catch (e) { console.error("[useFavorites] load", e); }
    };
    load();
  }, [userId]);

  const addToFavorites = useCallback(async (routeId: string) => {
    if (!db || !userId) return;
    setLoading(true);
    try {
      const snap = await getDocs(query(collection(db, "userProfiles"), where("userId", "==", userId)));
      if (snap.empty) return;
      const docId = snap.docs[0].id;
      const updated = [...favorites, routeId];
      await updateDoc(doc(db, "userProfiles", docId), { favorites: updated });
      setFavorites(updated);
    } catch (e) { console.error("[useFavorites] add", e); }
    finally { setLoading(false); }
  }, [userId, favorites]);

  const removeFromFavorites = useCallback(async (routeId: string) => {
    if (!db || !userId) return;
    setLoading(true);
    try {
      const snap = await getDocs(query(collection(db, "userProfiles"), where("userId", "==", userId)));
      if (snap.empty) return;
      const docId = snap.docs[0].id;
      const updated = favorites.filter(id => id !== routeId);
      await updateDoc(doc(db, "userProfiles", docId), { favorites: updated });
      setFavorites(updated);
    } catch (e) { console.error("[useFavorites] remove", e); }
    finally { setLoading(false); }
  }, [userId, favorites]);

  const toggleFavorite = useCallback(async (routeId: string) => {
    if (favorites.includes(routeId)) {
      await removeFromFavorites(routeId);
    } else {
      await addToFavorites(routeId);
    }
  }, [favorites, addToFavorites, removeFromFavorites]);

  return { favorites, toggleFavorite, loading };
}
