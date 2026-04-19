"use client";

import { useState, useEffect, useCallback } from "react";
import { collection, query, where, getDocs, doc, setDoc } from "firebase/firestore";
import { ref, uploadBytes } from "firebase/storage";
import { db, storage } from "@/lib/firebase";
import { GPXRoute } from "@/app/types";
import { parseGPXFile, nextColor, downloadGPXFile } from "@/lib/utils";

export interface RouteFilter {
  month?: string;
  type?: string;
  minDistance?: number;
  maxDistance?: number;
}

export interface RouteStats {
  totalRuns: number;
  totalDistance: number;
  totalElevation: number;
  totalTime: number;
}

export function useGPXRoutes(userId: string | null) {
  const [routes, setRoutes] = useState<GPXRoute[]>([]);
  const [loading, setLoading] = useState(false);

  // Load from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem("gpx-routes");
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) setRoutes(parsed);
      } catch {}
    }
  }, []);

  // Sync from Firestore when user is available
  useEffect(() => {
    if (!userId) return;
    const load = async () => {
      if (!db) return;
      try {
        const q = query(collection(db, "routes"), where("userId", "==", userId));
        const snap = await getDocs(q);
        const firestoreRoutes: GPXRoute[] = [];
        snap.forEach((d) => {
          const data = d.data();
          if (data.coordinates && Array.isArray(data.coordinates)) {
            firestoreRoutes.push({
              ...data,
              id: d.id,
              coordinates: data.coordinates.map((c: { lat: number; lon: number }) => [c.lon, c.lat] as [number, number]),
            } as GPXRoute);
          }
        });
        if (firestoreRoutes.length > 0) {
          firestoreRoutes.sort((a, b) => new Date(b.date).valueOf() - new Date(a.date).valueOf());
          setRoutes(firestoreRoutes);
        }
      } catch (e) {
        console.error("Firestore load error", e);
      }
    };
    load();
  }, [userId]);

  const saveRoutes = useCallback((newRoutes: GPXRoute[]) => {
    localStorage.setItem("gpx-routes", JSON.stringify(newRoutes));
    setRoutes(newRoutes);
  }, []);

  const uploadFiles = useCallback(
    async (files: File[], currentRoutes: GPXRoute[]): Promise<GPXRoute[]> => {
      setLoading(true);
      const newRoutes: GPXRoute[] = [];
      try {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const id = `route-${Date.now()}-${i}`;
          const text = await file.text();
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
            color: nextColor(),
            type: "road" as const,
            userId: userId || undefined,
          };

          // Upload GPX to Firebase Storage
          if (storage && userId) {
            try {
              await uploadBytes(ref(storage, `gpx-files/${userId}/${id}.gpx`), file);
            } catch (e) {
              console.error("Storage upload error", e);
            }
          }

          // Save to Firestore
          if (db && userId) {
            try {
              await setDoc(doc(db, "routes", id), {
                ...route,
                coordinates: route.coordinates.map(([lon, lat]) => ({ lat, lon })),
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
    [userId]
  );

  const deleteRoute = useCallback(
    async (id: string, currentRoutes: GPXRoute[]) => {
      const updated = currentRoutes.filter((r) => r.id !== id);
      saveRoutes(updated);
    },
    [saveRoutes]
  );

  const updateRoute = useCallback(
    async (id: string, name: string, type: string, currentRoutes: GPXRoute[]) => {
      const route = currentRoutes.find((r) => r.id === id);
      if (!route) return;

      // Find all routes with same name+date (same original upload)
      const dupIds = currentRoutes
        .filter((r) => r.name === route.name && r.date === route.date)
        .map((r) => r.id);

      const updated = currentRoutes.map((r) =>
        dupIds.includes(r.id) ? { ...r, name, type: type as "road" | "trail" | undefined } : r
      );
      saveRoutes(updated);

      if (db) {
        try {
          const { updateDoc } = await import("firebase/firestore");
          for (const did of dupIds) {
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

export function useRouteFilter(
  routes: GPXRoute[],
  baseFilter: RouteFilter,
  searchQuery: string
): GPXRoute[] {
  const [filtered, setFiltered] = useState<GPXRoute[]>(routes);

  useEffect(() => {
    let out = [...routes];
    if (baseFilter.month) out = out.filter((r) => r.date.startsWith(baseFilter.month!));
    if (baseFilter.minDistance !== undefined)
      out = out.filter((r) => r.distance / 1000 >= baseFilter.minDistance!);
    if (baseFilter.maxDistance !== undefined)
      out = out.filter((r) => r.distance / 1000 <= baseFilter.maxDistance!);
    if (baseFilter.type && baseFilter.type !== "all")
      out = out.filter((r) => r.type === baseFilter.type);
    if (searchQuery)
      out = out.filter((r) => r.name.toLowerCase().includes(searchQuery.toLowerCase()));
    setFiltered(out);
  }, [routes, baseFilter, searchQuery]);

  return filtered;
}

export function useRouteSuggestions(suggestDistance: number, avoidFamiliar: boolean) {
  const [suggestedRoute, setSuggestedRoute] = useState<GPXRoute | null>(null);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [apiKeyMissing, setApiKeyMissing] = useState(false);

  const getSuggestion = useCallback(
    async (startPoint: [number, number] | null, routes: GPXRoute[]) => {
      setIsSuggesting(true);
      setApiKeyMissing(false);
      try {
        // Determine start coordinates
        let lat = 59.3293; // Stockholm
        let lon = 18.0686;
        if (startPoint) {
          [lon, lat] = startPoint;
        } else if (routes.length > 0) {
          const allCoords = routes.flatMap((r) => r.coordinates);
          if (allCoords.length > 0) {
            lat = allCoords.reduce((s, c) => s + c[1], 0) / allCoords.length;
            lon = allCoords.reduce((s, c) => s + c[0], 0) / allCoords.length;
          }
        }

        const gpxFiles = routes.map((r) => {
          const pts = r.coordinates
            .map(([lon, lat]) => `<trkpt lat="${lat}" lon="${lon}"></trkpt>`)
            .join("");
          return `<?xml?><gpx><trk><trkseg>${pts}</trkseg></trk></gpx>`;
        });

        const res = await fetch("/api/generate-route", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            start: { lat, lng: lon },
            targetDistanceKm: suggestDistance,
            toleranceKm: 1,
            familiarityMode: avoidFamiliar ? "new" : "familiar",
            gpxFiles,
          }),
        });

        const payload = await res.json();
        if (!res.ok) {
          if (payload?.error?.includes("OPENROUTESERVICE_API_KEY")) setApiKeyMissing(true);
          throw new Error(payload?.error || "Request failed");
        }

        const best = payload?.routes?.[0];
        if (!best || !Array.isArray(best.geometry) || best.geometry.length < 2) {
          setSuggestedRoute(null);
          alert("No valid route found. Try another start point or distance.");
          return;
        }

        const coords = best.geometry.map((p: { lat: number; lng: number }) => [p.lng, p.lat] as [number, number]);
        setSuggestedRoute({
          id: `suggested-${Date.now()}`,
          name: `${avoidFamiliar ? "New" : "Familiar"} Loop — ${(best.distanceMeters / 1000).toFixed(1)}km`,
          date: new Date().toISOString(),
          coordinates: coords,
          distance: best.distanceMeters,
          elevationGain: 0,
          color: "#f472b6",
          isRoundTrip: true,
          familiarityScore: Math.round((best.familiarityRatio ?? 0) * 100),
        } as GPXRoute & { familiarityScore: number });
      } catch (err) {
        console.error(err);
        if (err instanceof Error && err.message.includes("OPENROUTESERVICE_API_KEY")) {
          setApiKeyMissing(true);
        } else {
          alert("Could not generate a valid route.");
        }
      } finally {
        setIsSuggesting(false);
      }
    },
    [suggestDistance, avoidFamiliar]
  );

  return { suggestedRoute, isSuggesting, apiKeyMissing, getSuggestion, clearSuggestion: () => setSuggestedRoute(null) };
}