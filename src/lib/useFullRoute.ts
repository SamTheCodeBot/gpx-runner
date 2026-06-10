"use client";

import { useState, useEffect, useCallback } from "react";
import { auth as firebaseAuth } from "@/lib/firebase";
import { GPXRoute } from "@/app/types";

async function fetchFullRoute(routeId: string): Promise<GPXRoute> {
  const user = firebaseAuth?.currentUser;
  if (!user) throw new Error("Not authenticated");

  const idToken = await user.getIdToken();
  const res = await fetch(`/api/routes/${routeId}`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });

  if (!res.ok) {
    throw new Error(`Route fetch failed: ${res.status}`);
  }

  const data = await res.json();
  return data.route as GPXRoute;
}

// Cache full routes in memory and localStorage
const routeCache = new Map<string, GPXRoute>();

function cacheRoute(route: GPXRoute) {
  routeCache.set(route.id, route);
  try {
    localStorage.setItem(`gpx-route-full-${route.id}`, JSON.stringify(route));
  } catch {}
}

function loadFromCache(routeId: string): GPXRoute | null {
  if (routeCache.has(routeId)) {
    return routeCache.get(routeId)!;
  }
  try {
    const stored = localStorage.getItem(`gpx-route-full-${routeId}`);
    if (!stored) return null;
    const route = JSON.parse(stored) as GPXRoute;
    routeCache.set(routeId, route);
    return route;
  } catch {
    return null;
  }
}

export function useFullRoute(routeId: string | null) {
  const [route, setRoute] = useState<GPXRoute | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!routeId) {
      setRoute(null);
      return;
    }

    // Check cache first
    const cached = loadFromCache(routeId);
    if (cached) {
      setRoute(cached);
      return;
    }

    // Fetch from API
    setLoading(true);
    setError(null);

    fetchFullRoute(routeId)
      .then((data) => {
        cacheRoute(data);
        setRoute(data);
        setLoading(false);
      })
      .catch((e) => {
        console.error("[useFullRoute]", e);
        setError(e instanceof Error ? e.message : "Failed to load route");
        setLoading(false);
      });
  }, [routeId]);

  return { route, loading, error };
}

// Prefetch full route data for a list of route IDs (useful when user hovers/clicks a route)
export function prefetchRoute(routeId: string) {
  if (routeCache.has(routeId)) return; // already cached

  firebaseAuth?.currentUser?.getIdToken().then((idToken) => {
    fetch(`/api/routes/${routeId}`, {
      headers: { Authorization: `Bearer ${idToken}` },
    })
      .then((res) => res.json())
      .then((data) => cacheRoute(data.route as GPXRoute))
      .catch(() => {}); // silent prefetch
  });
}