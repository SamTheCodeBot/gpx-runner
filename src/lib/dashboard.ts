"use client";

import { useState, useEffect, useCallback } from "react";
import { auth as firebaseAuth } from "@/lib/firebase";

const DASHBOARD_CACHE_VERSION = 2;
const DASHBOARD_CACHE_TTL_MS = 15 * 60 * 1000;

export interface DashboardRoute {
  id: string;
  name: string;
  date: string;
  distance: number;
  elevationGain: number;
  duration?: number;
  color: string;
  type: "road" | "trail" | "mixed";
  isRoundTrip: boolean;
  countries: string[];
  hasTcx: boolean;
  strava?: { activityId: number; sportType?: string; syncedAt: string };
  coordinates: [number, number][];
}

export interface DashboardProfile {
  id: string;
  username: string;
  displayName: string;
  avatar: string;
  joinedAt: string;
  totalRuns: number;
  totalDistance: number;
  wishlisted: string[];
  favorites: string[];
  strava?: {
    athleteId: number;
    athleteName?: string;
    scope: string;
    expiresAt?: number;
    connectedAt?: string;
    updatedAt?: string;
  };
}

interface DashboardData {
  profile: DashboardProfile | null;
  routes: DashboardRoute[];
  favorites: string[];
}

interface DashboardCachePayload {
  version: number;
  userId: string;
  cachedAt: number;
  data: DashboardData;
}

function dashboardCacheKey(userId: string) {
  return `gpx-dashboard-cache:${DASHBOARD_CACHE_VERSION}:${userId}`;
}

async function fetchDashboard(): Promise<DashboardData> {
  const user = firebaseAuth?.currentUser;
  if (!user) throw new Error("Not authenticated");

  const idToken = await user.getIdToken();

  const res = await fetch("/api/user/dashboard", {
    headers: { Authorization: `Bearer ${idToken}` },
  });

  if (!res.ok) {
    throw new Error(`Dashboard fetch failed: ${res.status}`);
  }

  const data = await res.json();
  return {
    ...data,
    routes: Array.isArray(data.routes)
      ? data.routes.map((route: DashboardRoute) => ({
          ...route,
          coordinates: route.coordinates ?? [],
          strava: route.strava ?? undefined,
        }))
      : [],
    favorites: Array.isArray(data.favorites) ? data.favorites : [],
  };
}

// Persist to localStorage for fast subsequent loads
function cacheDashboard(userId: string, data: DashboardData) {
  try {
    const payload: DashboardCachePayload = {
      version: DASHBOARD_CACHE_VERSION,
      userId,
      cachedAt: Date.now(),
      data,
    };
    localStorage.setItem(dashboardCacheKey(userId), JSON.stringify(payload));
  } catch {}
}

function loadCachedDashboard(userId: string): { data: DashboardData; fresh: boolean } | null {
  try {
    const stored = localStorage.getItem(dashboardCacheKey(userId));
    if (!stored) return null;
    const payload = JSON.parse(stored) as DashboardCachePayload;
    if (payload.version !== DASHBOARD_CACHE_VERSION || payload.userId !== userId) return null;
    return {
      data: payload.data,
      fresh: Date.now() - payload.cachedAt < DASHBOARD_CACHE_TTL_MS,
    };
  } catch {
    return null;
  }
}

export function useDashboard(userId: string | null) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load from cache immediately, then refresh from API
  useEffect(() => {
    if (!userId) {
      setData(null);
      setLoading(false);
      return;
    }

    // Show cached data immediately for fast first paint
    const cached = loadCachedDashboard(userId);
    if (cached) {
      setData(cached.data);
      setLoading(false);
      if (cached.fresh) return;
    }

    // No cache, or stale cache — fetch from API. Stale data stays visible.
    if (!cached) setLoading(true);
    setError(null);

    fetchDashboard()
      .then((fresh) => {
        cacheDashboard(userId, fresh);
        setData(fresh);
        setLoading(false);
      })
      .catch((e) => {
        console.error("[useDashboard]", e);
        setError(e instanceof Error ? e.message : "Failed to load dashboard");
        setLoading(false);
      });
  }, [userId]);

  const refresh = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const fresh = await fetchDashboard();
      cacheDashboard(userId, fresh);
      setData(fresh);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  return { data, loading, error, refresh };
}
