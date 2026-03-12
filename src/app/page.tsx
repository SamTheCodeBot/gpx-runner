"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { GPXRoute, RouteStats } from "./types";

// Dynamically import Map to avoid SSR issues
const MapWithNoSSR = dynamic(() => import("@/components/Map"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full bg-zinc-900 flex items-center justify-center">
      <div className="text-zinc-500">Loading map...</div>
    </div>
  ),
});

export default function Home() {
  const [routes, setRoutes] = useState<GPXRoute[]>([]);
  const [selectedRoute, setSelectedRoute] = useState<GPXRoute | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(true);
  const [stats, setStats] = useState<RouteStats | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load routes from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem("gpx-routes");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setRoutes(parsed);
        calculateStats(parsed);
      } catch (e) {
        console.error("Failed to load saved routes:", e);
      }
    }
  }, []);

  // Save routes to localStorage
  const saveRoutes = useCallback((newRoutes: GPXRoute[]) => {
    localStorage.setItem("gpx-routes", JSON.stringify(newRoutes));
    setRoutes(newRoutes);
    calculateStats(newRoutes);
  }, []);

  const calculateStats = (routeList: GPXRoute[]) => {
    if (routeList.length === 0) {
      setStats(null);
      return;
    }

    let totalDistance = 0;
    let totalElevation = 0;
    let totalTime = 0;
    const totalRuns = routeList.length;

    routeList.forEach((route) => {
      totalDistance += route.distance || 0;
      totalElevation += route.elevationGain || 0;
      if (route.duration) totalTime += route.duration;
    });

    setStats({
      totalRuns,
      totalDistance: Math.round(totalDistance / 1000 * 10) / 10, // km
      totalElevation: Math.round(totalElevation),
      totalTime, // minutes
    });
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsLoading(true);

    try {
      const newRoutes: GPXRoute[] = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const text = await file.text();
        
        // Parse GPX XML
        const parser = new DOMParser();
        const xml = parser.parseFromString(text, "application/xml");
        
        // Extract track points
        const trkpts = xml.querySelectorAll("trkpt");
        const coordinates: [number, number][] = [];
        let elevationGain = 0;
        let lastElevation: number | null = null;

        trkpts.forEach((pt) => {
          const lat = parseFloat(pt.getAttribute("lat") || "0");
          const lon = parseFloat(pt.getAttribute("lon") || "0");
          const ele = parseFloat(pt.querySelector("ele")?.textContent || "0");

          coordinates.push([lon, lat]);

          // Calculate elevation gain
          if (lastElevation !== null && ele > lastElevation) {
            elevationGain += ele - lastElevation;
          }
          lastElevation = ele;
        });

        // Calculate distance using Haversine formula
        let distance = 0;
        for (let i = 1; i < coordinates.length; i++) {
          distance += haversine(
            coordinates[i - 1][1],
            coordinates[i - 1][0],
            coordinates[i][1],
            coordinates[i][0]
          );
        }

        // Get date from GPX
        const timeEl = xml.querySelector("time");
        const date = timeEl?.textContent ? new Date(timeEl.textContent) : new Date();

        // Get route name
        const nameEl = xml.querySelector("name");
        const name = nameEl?.textContent || file.name.replace(".gpx", "");

        newRoutes.push({
          id: `route-${Date.now()}-${i}`,
          name,
          date: date.toISOString(),
          coordinates,
          distance,
          elevationGain,
          color: getRandomColor(),
        });
      }

      const updatedRoutes = [...routes, ...newRoutes];
      saveRoutes(updatedRoutes);
      
      // Auto-select first new route
      if (newRoutes.length > 0) {
        setSelectedRoute(newRoutes[0]);
      }
    } catch (error) {
      console.error("Error parsing GPX:", error);
      alert("Failed to parse GPX file. Please ensure it's a valid GPX file.");
    } finally {
      setIsLoading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const haversine = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371000; // Earth's radius in meters
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const getRandomColor = () => {
    const colors = [
      "#22d3ee", // cyan
      "#f472b6", // pink
      "#a78bfa", // violet
      "#34d399", // emerald
      "#fbbf24", // amber
      "#fb923c", // orange
      "#ef4444", // red
      "#3b82f6", // blue
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  };

  const deleteRoute = (id: string) => {
    const updated = routes.filter((r) => r.id !== id);
    saveRoutes(updated);
    if (selectedRoute?.id === id) {
      setSelectedRoute(null);
    }
  };

  const formatDuration = (minutes: number) => {
    const hrs = Math.floor(minutes / 60);
    const mins = Math.round(minutes % 60);
    return hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
  };

  const formatDate = (isoString: string) => {
    const date = new Date(isoString);
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  return (
    <div className="min-h-screen bg-[#0a0a0b] text-white">
      {/* Header */}
      <header className="border-b border-zinc-800 bg-[#0a0a0b]/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-400 to-cyan-600 flex items-center justify-center">
              <svg className="w-6 h-6 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div>
              <h1 className="text-xl font-bold bg-gradient-to-r from-cyan-400 to-cyan-200 bg-clip-text text-transparent">
                GPX Runner
              </h1>
              <p className="text-xs text-zinc-500">Visualize your running journey</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <label className="cursor-pointer px-4 py-2 bg-gradient-to-r from-cyan-500 to-cyan-600 hover:from-cyan-400 hover:to-cyan-500 text-black font-medium rounded-lg transition-all duration-200 flex items-center gap-2">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add GPX
              <input
                ref={fileInputRef}
                type="file"
                accept=".gpx"
                multiple
                onChange={handleFileUpload}
                className="hidden"
              />
            </label>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 flex gap-6">
        {/* Sidebar */}
        <aside className="w-80 flex-shrink-0 space-y-4">
          {/* Stats Card */}
          {stats && (
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-2xl p-5 animate-fade-in">
              <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-4">Your Running</h2>
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-zinc-800/50 rounded-xl p-3">
                  <div className="text-2xl font-bold text-cyan-400">{stats.totalRuns}</div>
                  <div className="text-xs text-zinc-500">Runs</div>
                </div>
                <div className="bg-zinc-800/50 rounded-xl p-3">
                  <div className="text-2xl font-bold text-pink-400">{stats.totalDistance}</div>
                  <div className="text-xs text-zinc-500">km total</div>
                </div>
                <div className="bg-zinc-800/50 rounded-xl p-3">
                  <div className="text-2xl font-bold text-violet-400">{stats.totalElevation}</div>
                  <div className="text-xs text-zinc-500">m elevation</div>
                </div>
                <div className="bg-zinc-800/50 rounded-xl p-3">
                  <div className="text-2xl font-bold text-amber-400">{formatDuration(stats.totalTime)}</div>
                  <div className="text-xs text-zinc-500">time</div>
                </div>
              </div>
            </div>
          )}

          {/* Routes List */}
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-2xl overflow-hidden">
            <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
              <h2 className="font-medium">Your Routes</h2>
              <span className="text-xs text-zinc-500">{routes.length} routes</span>
            </div>
            
            {routes.length === 0 ? (
              <div className="p-8 text-center">
                <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-zinc-800 flex items-center justify-center">
                  <svg className="w-8 h-8 text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
                  </svg>
                </div>
                <p className="text-zinc-400 mb-2">No routes yet</p>
                <p className="text-xs text-zinc-600">Upload GPX files to get started</p>
              </div>
            ) : (
              <div className="max-h-96 overflow-y-auto">
                {routes.map((route, index) => (
                  <div
                    key={route.id}
                    onClick={() => setSelectedRoute(route)}
                    className={`p-4 border-b border-zinc-800/50 cursor-pointer transition-colors hover:bg-zinc-800/30 ${
                      selectedRoute?.id === route.id ? "bg-zinc-800/50 border-l-2 border-l-cyan-400" : ""
                    }`}
                    style={{ animationDelay: `${index * 50}ms` }}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <h3 className="font-medium truncate">{route.name}</h3>
                        <p className="text-xs text-zinc-500 mt-1">{formatDate(route.date)}</p>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteRoute(route.id);
                        }}
                        className="p-1 text-zinc-600 hover:text-red-400 transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                    <div className="flex gap-3 mt-2 text-xs text-zinc-500">
                      <span>{(route.distance / 1000).toFixed(1)} km</span>
                      <span>↑{Math.round(route.elevationGain)}m</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Toggle Heatmap */}
          {routes.length > 0 && (
            <button
              onClick={() => setShowHeatmap(!showHeatmap)}
              className={`w-full py-3 px-4 rounded-xl border transition-all duration-200 flex items-center justify-center gap-2 ${
                showHeatmap
                  ? "bg-cyan-500/10 border-cyan-500/50 text-cyan-400"
                  : "bg-zinc-800/30 border-zinc-700 text-zinc-400 hover:border-zinc-600"
              }`}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              {showHeatmap ? "Heatmap ON" : "Heatmap OFF"}
            </button>
          )}
        </aside>

        {/* Map */}
        <div className="flex-1">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden" style={{ height: "calc(100vh - 180px)" }}>
            {routes.length > 0 ? (
              <MapWithNoSSR
                routes={routes}
                selectedRoute={selectedRoute}
                showHeatmap={showHeatmap}
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center text-zinc-500">
                <div className="w-24 h-24 mb-6 rounded-2xl bg-gradient-to-br from-zinc-800 to-zinc-900 flex items-center justify-center animate-pulse-glow">
                  <svg className="w-12 h-12 text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
                  </svg>
                </div>
                <h3 className="text-xl font-medium text-zinc-400 mb-2">Ready to map your runs</h3>
                <p className="text-zinc-600 text-center max-w-md">
                  Upload GPX files from your watch or running app to visualize your routes on the map
                </p>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Loading overlay */}
      {isLoading && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-zinc-900 border border-zinc-700 rounded-2xl p-6 flex items-center gap-4">
            <div className="w-6 h-6 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
            <span>Processing GPX...</span>
          </div>
        </div>
      )}
    </div>
  );
}
