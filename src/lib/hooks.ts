"use client";

import { useState, useEffect, useCallback } from "react";
import { collection, query, where, getDocs, doc, setDoc, updateDoc, deleteDoc } from "firebase/firestore";
import { ref, uploadBytes, deleteObject } from "firebase/storage";
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

  // Sync from Firestore when user is available — always overwrite local state
  // so a new user never sees another account's routes from localStorage
  useEffect(() => {
    if (!userId) {
      setRoutes([]);
      return;
    }
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
        firestoreRoutes.sort((a, b) => new Date(b.date).valueOf() - new Date(a.date).valueOf());
        setRoutes(firestoreRoutes);
        localStorage.setItem("gpx-routes", JSON.stringify(firestoreRoutes));
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
      const route = currentRoutes.find((r) => r.id === id);
      if (!route) return;
      if (!confirm(`Delete "${route.name}"? This cannot be undone.`)) return;
      const updated = currentRoutes.filter((r) => r.id !== id);
      saveRoutes(updated);
      if (storage && userId) {
        try {
          await deleteObject(ref(storage, `gpx-files/${userId}/${id}.gpx`));
        } catch (e) {
          console.error("Failed to delete from Firebase Storage", e);
        }
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
        dupIds.includes(r.id) ? { ...r, name, type: type as "road" | "trail" | "mixed" | undefined } : r
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
            familiarityMode: avoidFamiliar ? "novel" : "familiar",
            gpxFiles,
          }),
        });

        const payload = await res.json();

        if (res.ok && payload?.routes?.[0]?.geometry?.length > 1) {
          // API available — use OpenRouteService
          const best = payload.routes[0];
          const coords = best.geometry.map(
            (p: { lat: number; lng: number }) => [p.lng, p.lat] as [number, number]
          );
          setSuggestedRoute({
            id: `suggested-${Date.now()}`,
            name: `${avoidFamiliar ? "New" : "Familiar"} Loop — ${(best.distanceMeters / 1000).toFixed(1)}km`,
            date: new Date().toISOString(),
            coordinates: coords,
            distance: best.distanceMeters,
            elevationGain: 0,
            color: "#f472b6",
            isRoundTrip: true,
            type: "road",
            familiarityScore: Math.round((best.familiarityRatio ?? 0) * 100),
          } as GPXRoute & { familiarityScore: number });
        } else {
          // API unavailable — fall back to client-side algorithm
          if (!res.ok && payload?.error?.includes("OPENROUTESERVICE_API_KEY")) {
            setApiKeyMissing(true);
          }
          const { generateRandomRoute } = await import("@/lib/utils");
          const seed = Date.now();
          const existingCoords = routes.map((r) => r.coordinates);
          const generated = generateRandomRoute(
            [lon, lat], suggestDistance, "mixed",
            avoidFamiliar ? "novel" : "familiar", existingCoords, seed
          );
          setSuggestedRoute({
            id: `suggested-${Date.now()}`,
            name: `${generated.name} — ${(generated.distance / 1000).toFixed(1)}km`,
            date: new Date().toISOString(),
            coordinates: generated.coordinates,
            distance: generated.distance,
            elevationGain: generated.elevationGain,
            color: "#f472b6",
            isRoundTrip: true,
            type: "mixed",
            familiarityScore: avoidFamiliar ? 75 : 40,
          } as GPXRoute & { familiarityScore: number });
        }
      } catch (err) {
        console.error(err);
        // Network error or any other failure — always fall back to client-side algorithm
        if (err instanceof Error && err.message.includes("OPENROUTESERVICE_API_KEY")) {
          setApiKeyMissing(true);
        }
        try {
          const { generateRandomRoute } = await import("@/lib/utils");
          let lat2 = 59.3293, lon2 = 18.0686;
          if (startPoint) { [lon2, lat2] = startPoint; }
          else if (routes.length > 0) {
            const allCoords = routes.flatMap((r) => r.coordinates);
            if (allCoords.length > 0) {
              lat2 = allCoords.reduce((s, c) => s + c[1], 0) / allCoords.length;
              lon2 = allCoords.reduce((s, c) => s + c[0], 0) / allCoords.length;
            }
          }
          const generated = generateRandomRoute(
            [lon2, lat2], suggestDistance, "mixed",
            avoidFamiliar ? "novel" : "familiar", [], Date.now()
          );
          setSuggestedRoute({
            id: `suggested-${Date.now()}`,
            name: `${generated.name} — ${(generated.distance / 1000).toFixed(1)}km`,
            date: new Date().toISOString(),
            coordinates: generated.coordinates,
            distance: generated.distance,
            elevationGain: generated.elevationGain,
            color: "#f472b6",
            isRoundTrip: true,
            type: "mixed",
            familiarityScore: avoidFamiliar ? 75 : 40,
          } as GPXRoute & { familiarityScore: number });
        } catch {
          setSuggestedRoute(null);
        }
      } finally {
        setIsSuggesting(false);
      }
    },
    [suggestDistance, avoidFamiliar]
  );

  return { suggestedRoute, isSuggesting, apiKeyMissing, getSuggestion, clearSuggestion: () => setSuggestedRoute(null) };
}
// ─── useUserProfile ────────────────────────────────────────────────────────────

export function useUserProfile(userId: string | null) {
  const [profile, setProfile] = useState<import("@/app/types").UserProfile | null>(null);
  const [loading, setLoading] = useState(true); // start true so skeleton shows until confirmed

  const loadProfile = useCallback(async () => {
    if (!db || !userId) return;
    try {
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
