#!/usr/bin/env python3
import os

# MapAdmin component
mapadmin = '''"use client";

import { useState, useEffect, useRef } from "react";
import { MapContainer, TileLayer, Polyline, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

interface RouteSummary {
  id: string;
  name: string;
  type: "road" | "trail" | "mixed";
  coordinates: [number, number][];
}

interface MapAdminProps {
  routes: RouteSummary[];
  darkMode?: boolean;
  clusteringEnabled?: boolean;
}

const TYPE_COLORS: Record<string, string> = {
  road: "rgb(255 65 164)",
  trail: "rgb(18 221 251)",
  mixed: "rgb(197 45 255)",
};

function routeCentroid(route: RouteSummary): [number, number] | null {
  if (!route.coordinates.length) return null;
  return [
    route.coordinates.reduce((sum, [lon]) => sum + lon, 0) / route.coordinates.length,
    route.coordinates.reduce((sum, [, lat]) => sum + lat, 0) / route.coordinates.length,
  ];
}

function MapBoundsController({ routes }: { routes: RouteSummary[] }) {
  const map = useMap();
  const lastBoundsRef = useRef<string | null>(null);

  useEffect(() => {
    if (routes.length === 0) return;

    const allCoords: [number, number][] = [];
    for (const route of routes) {
      for (const [lon, lat] of route.coordinates) {
        allCoords.push([lat, lon]);
      }
    }

    if (allCoords.length === 0) return;

    const bounds = L.latLngBounds(allCoords);
    const boundsKey = bounds.toBBoxString();

    if (lastBoundsRef.current !== boundsKey) {
      map.fitBounds(bounds, { padding: [40, 40] });
      lastBoundsRef.current = boundsKey;
    }
  }, [map, routes]);

  return null;
}

function ClusterMarkers({ routes, enabled }: { routes: RouteSummary[]; enabled: boolean }) {
  const map = useMap();
  const [mapState, setMapState] = useState({ zoom: map.getZoom(), tick: 0 });

  useEffect(() => {
    const update = () => setMapState((state) => ({ zoom: map.getZoom(), tick: state.tick + 1 }));
    update();
    map.on("moveend zoomend resize", update);
    return () => { map.off("moveend zoomend resize", update); };
  }, [map]);

  if (!enabled || mapState.zoom >= 10) return null;

  const clusterDistancePx = mapState.zoom <= 5 ? 78 : 58;
  const clusters: Array<{
    routes: RouteSummary[];
    lng: number;
    lat: number;
    x: number;
    y: number;
  }> = [];

  for (const route of routes) {
    const centroid = routeCentroid(route);
    if (!centroid) continue;
    const [lng, lat] = centroid;
    const point = map.latLngToContainerPoint([lat, lng]);
    const existing = clusters.find((cluster) => {
      const dx = cluster.x - point.x;
      const dy = cluster.y - point.y;
      return Math.sqrt(dx * dx + dy * dy) <= clusterDistancePx;
    });

    if (existing) {
      existing.routes.push(route);
      const totalLng = existing.routes.reduce((s, r) => s + (routeCentroid(r)?.[0] ?? 0), 0);
      const totalLat = existing.routes.reduce((s, r) => s + (routeCentroid(r)?.[1] ?? 0), 0);
      existing.lng = totalLng / existing.routes.length;
      existing.lat = totalLat / existing.routes.length;
      const nextPoint = map.latLngToContainerPoint([existing.lat, existing.lng]);
      existing.x = nextPoint.x;
      existing.y = nextPoint.y;
    } else {
      clusters.push({ routes: [route], lng, lat, x: point.x, y: point.y });
    }
  }

  return (
    <>
      {clusters.map((cluster) => {
        const routeCount = cluster.routes.length;
        const icon = L.divIcon({
          html: '<div style="width:34px;height:34px;border-radius:999px;display:flex;align-items:center;justify-content:center;background:rgb(255 65 164);color:white;border:3px solid white;font-size:13px;font-weight:900;box-shadow:0 4px 14px rgba(0,0,0,0.28);">' + routeCount + '</div>',
          className: "",
          iconSize: [34, 34],
          iconAnchor: [17, 17],
        });

        return (
          <Marker
            key={cluster.routes.map((r) => r.id).join("|")}
            position={[cluster.lat, cluster.lng]}
            icon={icon}
            eventHandlers={{
              click: () => {
                const coords = cluster.routes.flatMap((route) => route.coordinates);
                if (!coords.length) return;
                map.fitBounds(L.latLngBounds(coords.map(([lon, lat]) => [lat, lon] as [number, number])), { padding: [70, 70] });
              },
            }}
          >
            <Popup>
              {routeCount === 1 ? cluster.routes[0].name : routeCount + " routes in this area"}
            </Popup>
          </Marker>
        );
      })}
    </>
  );
}

export default function MapAdmin({ routes, darkMode = true, clusteringEnabled = false }: MapAdminProps) {
  const center: [number, number] = routes.length > 0
    ? (() => {
        const allCoords = routes.flatMap((r) => r.coordinates);
        if (allCoords.length === 0) return [59.3293, 18.0686] as [number, number];
        const avgLat = allCoords.reduce((s, [, lat]) => s + lat, 0) / allCoords.length;
        const avgLon = allCoords.reduce((s, [lon]) => s + lon, 0) / allCoords.length;
        return [avgLat, avgLon] as [number, number];
      })()
    : [59.3293, 18.0686] as [number, number];

  return (
    <MapContainer
      center={center}
      zoom={13}
      style={{ height: "100%", width: "100%", background: darkMode ? "#111113" : "#f4f4f5" }}
      zoomControl={true}
      dragging={true}
      doubleClickZoom={true}
      scrollWheelZoom={true}
      attributionControl={false}
    >
      <TileLayer
        attribution='&copy; <a href="https://carto.com/">CARTO</a>'
        url={darkMode
          ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
        }
      />
      <MapBoundsController routes={routes} />
      <ClusterMarkers routes={routes} enabled={clusteringEnabled} />
      {routes.map((route) => (
        <Polyline
          key={route.id}
          positions={route.coordinates.map(([lon, lat]) => [lat, lon] as [number, number])}
          pathOptions={{
            color: TYPE_COLORS[route.type] || TYPE_COLORS.road,
            weight: 3,
            opacity: 0.85,
            lineCap: "round",
            lineJoin: "round",
          }}
        />
      ))}
    </MapContainer>
  );
}
'''

with open('src/components/MapAdmin.tsx', 'w') as f:
    f.write(mapadmin)
print("MapAdmin.tsx written")

# page.tsx - crewcaptain page
page = '''"use client";

import { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, User } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { Icon } from "@/components/ui";
import { AdminSidebar } from "@/components/AdminSidebar";

const MapAdmin = dynamic(() => import("@/components/MapAdmin"), { ssr: false });

interface AdminStats {
  registeredUsers: number;
  totalRoutes: number;
  roadRoutes: number;
  trailRoutes: number;
  mixedRoutes: number;
}

interface RouteSummary {
  id: string;
  name: string;
  type: "road" | "trail" | "mixed";
  coordinates: [number, number][];
}

interface UserSummary {
  id: string;
  username: string;
  email: string;
  routeCount: number;
  stravaConnected: boolean;
  isAdmin: boolean;
}

const ADMIN_EMAIL = "mago@osterhult.com";
const SESSION_KEY = "cc_admin_token";
const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

function AdminLogin({ onLogin }: { onLogin: (user: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const cred = await signInWithEmailAndPassword(auth!, email, password);
      if (cred.user.email?.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
        await signOut(auth!);
        setError("Access denied — not an admin account.");
        return;
      }
      onLogin(cred.user);
    } catch (err: any) {
      setError(err.message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3 mb-8 justify-center">
          <div className="w-12 h-12 rounded-2xl bg-primary-container flex items-center justify-center">
            <Icon name="shield" filled className="text-on-primary-container text-2xl" />
          </div>
          <div>
            <h1 className="text-2xl font-extrabold text-primary font-headline tracking-tight">Crew Captain</h1>
            <p className="text-xs text-on-surface-variant">Admin Dashboard</p>
          </div>
        </div>
        <div className="bg-surface-container-lowest rounded-3xl shadow-lg p-6">
          <h2 className="text-lg font-extrabold text-primary mb-1">Sign in</h2>
          <p className="text-xs text-on-surface-variant mb-5">Restricted access — crew only</p>
          {error && (
            <div className="mb-3 px-3 py-2 bg-error-container rounded-xl text-xs font-medium text-error">{error}</div>
          )}
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant block mb-1">Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="crew@example.com" required
                className="w-full px-3 py-2.5 bg-surface-container border border-outline-variant rounded-xl text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
            <div>
              <label className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant block mb-1">Password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="********" required
                className="w-full px-3 py-2.5 bg-surface-container border border-outline-variant rounded-xl text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
            <button type="submit" disabled={loading}
              className="w-full py-3 bg-primary text-on-primary rounded-xl text-sm font-bold hover:opacity-90 transition-opacity disabled:opacity-50">
              {loading ? "Signing in\u2026" : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, unit, icon }: { label: string; value: string; unit?: string; icon: string }) {
  return (
    <div className="bg-surface-container rounded-xl px-3 py-2.5 flex items-center gap-2 shadow-card">
      <div className="w-8 h-8 rounded-lg bg-surface-container-high flex items-center justify-center shrink-0">
        <Icon name={icon} className="text-on-surface-variant text-base" />
      </div>
      <div>
        <p className="text-[9px] font-extrabold uppercase tracking-wider text-on-surface-variant leading-tight">{label}</p>
        <p className="text-sm font-extrabold text-primary leading-none">
          {value}{unit && <span className="text-[10px] font-medium text-on-surface-variant ml-0.5">{unit}</span>}
        </p>
      </div>
    </div>
  );
}

function RoutesView({ user }: { user: User }) {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [routes, setRoutes] = useState<RouteSummary[]>([]);
  const [activeType, setActiveType] = useState<string>("all");
  const [loadingStats, setLoadingStats] = useState(true);
  const [loadingRoutes, setLoadingRoutes] = useState(true);

  const loadStats = async (idToken: string) => {
    try {
      const res = await fetch("/api/crewcaptain/stats", { headers: { Authorization: `Bearer ${idToken}` } });
      if (res.ok) setStats(await res.json());
    } finally { setLoadingStats(false); }
  };

  const loadRoutes = async (idToken: string, type: string) => {
    setLoadingRoutes(true);
    try {
      const url = type === "all" ? "/api/crewcaptain/routes" : `/api/crewcaptain/routes?type=${type}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
      if (res.ok) { const data = await res.json(); setRoutes(data.routes || []); }
    } finally { setLoadingRoutes(false); }
  };

  useEffect(() => {
    const getIdToken = async () => {
      const idToken = await user.getIdToken();
      sessionStorage.setItem(SESSION_KEY, idToken);
      await Promise.all([loadStats(idToken), loadRoutes(idToken, activeType)]);
    };
    getIdToken();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTypeChange = async (type: string) => {
    setActiveType(type);
    const idToken = sessionStorage.getItem(SESSION_KEY) || await user.getIdToken();
    await loadRoutes(idToken, type);
  };

  const filteredRoutes = activeType === "all" ? routes : routes.filter((r) => r.type === activeType);

  return (
    <div className="flex-1 overflow-y-auto px-4 pt-6 pb-8 custom-scrollbar">
      <div className="flex items-center gap-4 mb-6">
        <div className="w-12 h-12 rounded-2xl bg-primary-container flex items-center justify-center shrink-0 shadow-card">
          <Icon name="dashboard" filled className="text-on-primary-container text-2xl" />
        </div>
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface font-headline">Routes</h1>
          <p className="text-sm text-on-surface-variant">Platform overview and statistics</p>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-8">
        {loadingStats ? (
          <>{[...Array(5)].map((_, i) => (<div key={i} className="bg-surface-container rounded-xl px-3 py-2.5 animate-pulse h-16" />))}</>
        ) : stats ? (
          <>
            <StatCard label="Registered Users" value={String(stats.registeredUsers)} icon="group" />
            <StatCard label="Total Routes" value={String(stats.totalRoutes)} icon="route" />
            <StatCard label="Road" value={String(stats.roadRoutes)} icon="directions_run" />
            <StatCard label="Trail" value={String(stats.trailRoutes)} icon="terrain" />
            <StatCard label="Mixed" value={String(stats.mixedRoutes)} icon="all_inclusive" />
          </>
        ) : (
          <p className="col-span-5 text-sm text-on-surface-variant text-center py-4">Failed to load stats.</p>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-extrabold text-on-surface">Route Map</h2>
          <div className="flex items-center gap-1.5">
            {["all", "road", "trail", "mixed