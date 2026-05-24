"use client";

import { useState, useEffect, useCallback } from "react";
import { auth as firebaseAuth } from "@/lib/firebase";

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
  strava: { activityId: number; sportType?: string; syncedAt: string } | null;
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
  strava: {
    athleteId: number;
    athleteName?: string;
    scope: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    connectedAt: string;
    updatedAt: string;
  } | null;
}

interface DashboardData {
  profile: DashboardProfile | null;
  routes: DashboardRoute[];
  favorites: string[];
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

  return res.json();
}

// Persist to localStorage for fast subsequent loads
function cacheDashboard(data: DashboardData) {
  try {
    localStorage.setItem("gpx-dashboard-cache", JSON.stringify(data));
  } catch {}
}

function loadCachedDashboard(): DashboardData | null {
  try {
    const stored = localStorage.getItem("gpx-dashboard-cache");
    if (!stored) return null;
    return JSON.parse(stored) as DashboardData;
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
    const cached = loadCachedDashboard();
    if (cached) {
      setData(cached);
      setLoading(false);
      // Refresh in background
      fetchDashboard()
        .then((fresh) => {
          cacheDashboard(fresh);
          setData(fresh);
        })
        .catch((e) => {
          console.warn("[useDashboard] background refresh failed", e);
        });
      return;
    }

    // No cache — must fetch from API
    setLoading(true);
    setError(null);

    fetchDashboard()
      .then((fresh) => {
        cacheDashboard(fresh);
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
      cacheDashboard(fresh);
      setData(fresh);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  return { data, loading, error, refresh };
}