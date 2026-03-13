"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { GPXRoute, RouteStats, RouteFilter, RouteSuggestion } from "./types";

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
  const [filteredRoutes, setFilteredRoutes] = useState<GPXRoute[]>([]);
  const [selectedRoute, setSelectedRoute] = useState<GPXRoute | null>(null);
  const [suggestedRoute, setSuggestedRoute] = useState<RouteSuggestion | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(true);
  const [stats, setStats] = useState<RouteStats | null>(null);
  const [filter, setFilter] = useState<RouteFilter>({});
  const [showFilters, setShowFilters] = useState(false);
  const [showSuggestPanel, setShowSuggestPanel] = useState(false);
  const [suggestDistance, setSuggestDistance] = useState(5);
  const [avoidFamiliar, setAvoidFamiliar] = useState(true);
  const [selectedStartPoint, setSelectedStartPoint] = useState<[number, number] | null>(null);
  const [isSelectingStartPoint, setIsSelectingStartPoint] = useState(false);
  const [apiKeyMissing, setApiKeyMissing] = useState(false);
  const [darkMode, setDarkMode] = useState(true); // Dark mode by default
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load routes from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem("gpx-routes");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setRoutes(parsed);
        applyFilter(parsed, filter);
      } catch (e) {
        console.error("Failed to load saved routes:", e);
      }
    }
  }, []);

  // Apply filter whenever filter or routes change
  useEffect(() => {
    applyFilter(routes, filter);
  }, [filter, routes]);

  // Handle dark mode class on body
  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.remove('light-mode');
    } else {
      document.documentElement.classList.add('light-mode');
    }
  }, [darkMode]);

  const applyFilter = (routeList: GPXRoute[], currentFilter: RouteFilter) => {
    let filtered = [...routeList];

    // Filter by month
    if (currentFilter.month) {
      filtered = filtered.filter(r => r.date.startsWith(currentFilter.month!));
    }

    // Filter by distance
    if (currentFilter.minDistance !== undefined) {
      filtered = filtered.filter(r => r.distance / 1000 >= currentFilter.minDistance!);
    }
    if (currentFilter.maxDistance !== undefined) {
      filtered = filtered.filter(r => r.distance / 1000 <= currentFilter.maxDistance!);
    }

    // Filter by type
    // Filter by type - removed since we can't detect road vs trail
    // if (currentFilter.type && currentFilter.type !== 'all') {
    //   filtered = filtered.filter(r => r.type === currentFilter.type);
    // }

    setFilteredRoutes(filtered);
    calculateStats(filtered);
  };

  // Save routes to localStorage
  const saveRoutes = useCallback((newRoutes: GPXRoute[]) => {
    localStorage.setItem("gpx-routes", JSON.stringify(newRoutes));
    setRoutes(newRoutes);
    applyFilter(newRoutes, filter);
  }, [filter]);

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
      totalDistance: Math.round(totalDistance / 1000 * 10) / 10,
      totalElevation: Math.round(totalElevation),
      totalTime,
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
        
        const parser = new DOMParser();
        const xml = parser.parseFromString(text, "application/xml");
        
        const trkpts = xml.querySelectorAll("trkpt");
        const coordinates: [number, number][] = [];
        let elevationGain = 0;
        let lastElevation: number | null = null;

        trkpts.forEach((pt) => {
          const lat = parseFloat(pt.getAttribute("lat") || "0");
          const lon = parseFloat(pt.getAttribute("lon") || "0");
          const ele = parseFloat(pt.querySelector("ele")?.textContent || "0");

          coordinates.push([lon, lat]);

          if (lastElevation !== null && ele > lastElevation) {
            elevationGain += ele - lastElevation;
          }
          lastElevation = ele;
        });

        let distance = 0;
        for (let i = 1; i < coordinates.length; i++) {
          distance += haversine(
            coordinates[i - 1][1],
            coordinates[i - 1][0],
            coordinates[i][1],
            coordinates[i][0]
          );
        }

        const timeEl = xml.querySelector("time");
        const date = timeEl?.textContent ? new Date(timeEl.textContent) : new Date();

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
    const R = 6371000;
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
      "#22d3ee", "#f472b6", "#a78bfa", "#34d399",
      "#fbbf24", "#fb923c", "#ef4444", "#3b82f6",
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

  const discardSuggestion = () => {
    setSuggestedRoute(null);
  };

  const downloadGPX = (route: { coordinates: [number, number][]; name: string; distance: number; elevationGain: number }) => {
    // Convert coordinates to GPX format with Garmin-compatible structure
    const gpxPoints = route.coordinates
      .map(([lon, lat]) => `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">
        <ele>0</ele>
        <time>${new Date().toISOString()}</time>
      </trkpt>`)
      .join('\n');
    
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GPX Runner" 
  xmlns="http://www.topografix.com/GPX/1/1" 
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${route.name}</name>
    <time>${new Date().toISOString()}</time>
  </metadata>
  <trk>
    <name>${route.name}</name>
    <trkseg>
${gpxPoints}
    </trkseg>
  </trk>
</gpx>`;

    // Download the file
    const blob = new Blob([gpx], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${route.name.replace(/\s+/g, '_')}.gpx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const getSuggestion = async () => {
    setIsSuggesting(true);
    setApiKeyMissing(false);

    try {
      // Use selected start point, or center from existing routes, or default to Stockholm
      let centerLat: number;
      let centerLon: number;

      if (selectedStartPoint) {
        centerLat = selectedStartPoint[1];
        centerLon = selectedStartPoint[0];
      } else if (routes.length > 0) {
        const allCoords = routes.flatMap(r => r.coordinates);
        centerLat = allCoords.reduce((sum, [, lat]) => sum + lat, 0) / allCoords.length;
        centerLon = allCoords.reduce((sum, [lon]) => sum + lon, 0) / allCoords.length;
      } else {
        centerLat = 59.3293;
        centerLon = 18.0686;
      }

      const response = await fetch('/api/routes/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          distance: suggestDistance,
          type: 'mixed',
          avoidFamiliar,
          centerLat,
          centerLon,
          existingRoutes: avoidFamiliar ? routes.map(r => ({ coordinates: r.coordinates })) : [],
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        if (error.error.includes('API key')) {
          setApiKeyMissing(true);
        }
        throw new Error(error.error || 'Failed to get suggestion');
      }

      const suggestion = await response.json();
      setSuggestedRoute(suggestion);
      setShowSuggestPanel(false);
      setIsSelectingStartPoint(false);
    } catch (error: any) {
      console.error('Suggestion error:', error);
      if (!apiKeyMissing) {
        alert(error.message || 'Failed to get route suggestion');
      }
    } finally {
      setIsSuggesting(false);
    }
  };

  const handleMapClick = (lat: number, lon: number) => {
    if (isSelectingStartPoint) {
      setSelectedStartPoint([lon, lat]);
      setIsSelectingStartPoint(false);
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

  const getMonthOptions = () => {
    const months = new Set(routes.map(r => r.date.substring(0, 7)));
    return Array.from(months).sort().reverse();
  };

  const getDisplayRoutes = () => {
    if (suggestedRoute) return [];
    return filteredRoutes;
  };

  return (
    <div className={`min-h-screen ${darkMode ? 'bg-[#0a0a0b]' : 'bg-gray-100'} ${darkMode ? 'text-white' : 'text-gray-900'}`}>
      {/* Header */}
      <header className={`border-b ${darkMode ? 'border-zinc-800 bg-[#0a0a0b]/80' : 'border-gray-200 bg-white/80'} backdrop-blur-md sticky top-0 z-50`}>
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button 
              onClick={() => window.location.reload()}
              className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-400 to-cyan-600 flex items-center justify-center hover:scale-105 transition-transform"
            >
              <svg className="w-6 h-6 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </button>
            <div>
              <button 
                onClick={() => window.location.reload()}
                className="text-xl font-bold bg-gradient-to-r from-cyan-400 to-cyan-200 bg-clip-text text-transparent hover:opacity-80 transition-opacity"
              >
                GPX Runner
              </button>
              <p className={`text-xs ${darkMode ? 'text-zinc-500' : 'text-gray-500'}`}>Visualize your running journey</p>
            </div>
          </div>

          <div className="flex items-center gap-2 md:gap-3">
            {/* Dark/Light Mode Toggle */}
            <button
              onClick={() => setDarkMode(!darkMode)}
              className={`p-2 rounded-lg border transition-colors ${
                darkMode 
                  ? 'border-zinc-700 text-zinc-400 hover:border-zinc-600' 
                  : 'border-gray-300 text-gray-600 hover:border-gray-400'
              }`}
              title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
            >
              {darkMode ? (
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                </svg>
              )}
            </button>
            
            <button
              onClick={() => setShowSuggestPanel(!showSuggestPanel)}
              className="px-3 md:px-4 py-2 bg-gradient-to-r from-pink-500 to-pink-600 hover:from-pink-400 hover:to-pink-500 text-white font-medium rounded-lg transition-all duration-200 flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
              Suggest Route
            </button>
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`px-4 py-2 border rounded-lg transition-all duration-200 flex items-center gap-2 ${
                showFilters || filter.month
                  ? "border-cyan-500 bg-cyan-500/10 text-cyan-400"
                  : "border-zinc-700 text-zinc-400 hover:border-zinc-600"
              }`}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
              </svg>
              Filter
            </button>
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

      {/* Suggest Route Panel - sticky when open */}
      {showSuggestPanel && (
        <div className="sticky top-[73px] z-40 border-b border-zinc-800 bg-zinc-900/95 backdrop-blur-md p-4 animate-fade-in shadow-lg">
          <div className="max-w-7xl mx-auto flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <label className="text-sm text-zinc-400">Distance:</label>
              <select
                value={suggestDistance}
                onChange={(e) => setSuggestDistance(Number(e.target.value))}
                className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white"
              >
                <option value={3}>3 km</option>
                <option value={5}>5 km</option>
                <option value={10}>10 km</option>
                <option value={15}>15 km</option>
                <option value={21}>21 km (half marathon)</option>
                <option value={42}>42 km (marathon)</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm text-zinc-400">Route type:</label>
              <select
                value={avoidFamiliar ? 'unfamiliar' : 'familiar'}
                onChange={(e) => setAvoidFamiliar(e.target.value === 'unfamiliar')}
                className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white"
              >
                <option value="unfamiliar">🆕 New paths (unfamiliar)</option>
                <option value="familiar">🔄 Familiar paths</option>
              </select>
            </div>
            <button
              onClick={() => setIsSelectingStartPoint(true)}
              className={`px-4 py-2 border rounded-lg transition-colors flex items-center gap-2 ${
                selectedStartPoint 
                  ? "border-cyan-500 bg-cyan-500/10 text-cyan-400"
                  : isSelectingStartPoint
                  ? "border-amber-500 bg-amber-500/10 text-amber-400"
                  : "border-zinc-700 text-zinc-400 hover:border-zinc-600"
              }`}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              {selectedStartPoint ? "Start point set ✓" : "Pick start point"}
            </button>
            <button
              onClick={getSuggestion}
              disabled={isSuggesting}
              className="px-4 py-2 bg-pink-500 hover:bg-pink-400 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {isSuggesting ? (
                <>
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Generating route...
                </>
              ) : (
                'Get Suggestion'
              )}
            </button>
            {isSelectingStartPoint && (
              <span className="text-amber-400 text-sm">👆 Click on the map to set start point</span>
            )}
          </div>
        </div>
      )}

      {/* Filters Panel */}
      {showFilters && (
        <div className="border-b border-zinc-800 bg-zinc-900/50 p-4 animate-fade-in">
          <div className="max-w-7xl mx-auto flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <label className="text-sm text-zinc-400">Month:</label>
              <select
                value={filter.month || ''}
                onChange={(e) => setFilter({ ...filter, month: e.target.value || undefined })}
                className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white"
              >
                <option value="">All months</option>
                {getMonthOptions().map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2">
              <span className={`text-sm ${darkMode ? 'text-zinc-400' : 'text-gray-600'}`}>Distance (km):</span>
              <input
                type="number"
                placeholder="Min"
                value={filter.minDistance || ''}
                onChange={(e) => setFilter({ ...filter, minDistance: e.target.value ? Number(e.target.value) : undefined })}
                className={`w-16 px-2 py-1 text-sm rounded ${darkMode ? 'bg-zinc-800 border-zinc-700 text-white' : 'bg-gray-100 border-gray-300 text-gray-900'}`}
              />
              <span className={darkMode ? 'text-zinc-500' : 'text-gray-400'}>-</span>
              <input
                type="number"
                placeholder="Max"
                value={filter.maxDistance || ''}
                onChange={(e) => setFilter({ ...filter, maxDistance: e.target.value ? Number(e.target.value) : undefined })}
                className={`w-16 px-2 py-1 text-sm rounded ${darkMode ? 'bg-zinc-800 border-zinc-700 text-white' : 'bg-gray-100 border-gray-300 text-gray-900'}`}
              />
            </div>
            <button
              onClick={() => setFilter({})}
              className="px-3 py-2 text-sm text-zinc-400 hover:text-white transition-colors"
            >
              Clear filters
            </button>
          </div>
        </div>
      )}

      <main className="max-w-7xl mx-auto px-4 py-4 md:py-6 flex flex-col md:flex-row gap-4 md:gap-6">
        {/* Sidebar */}
        <aside className={`w-full md:w-80 flex-shrink-0 space-y-4 ${darkMode ? '' : 'bg-white rounded-2xl p-4'}`}>
          {/* Stats Card */}
          {stats && (
            <div className={`rounded-2xl p-5 animate-fade-in ${darkMode ? 'bg-zinc-900/50 border border-zinc-800' : 'bg-white border border-gray-200'}`}>
              <h2 className={`text-sm font-medium uppercase tracking-wider mb-4 ${darkMode ? 'text-zinc-400' : 'text-gray-500'}`}>Your Running</h2>
              <div className="grid grid-cols-2 gap-4">
                <div className={`rounded-xl p-3 ${darkMode ? 'bg-zinc-800/50' : 'bg-gray-100'}`}>
                  <div className="text-2xl font-bold text-cyan-500">{stats.totalRuns}</div>
                  <div className={`text-xs ${darkMode ? 'text-zinc-500' : 'text-gray-500'}`}>Runs</div>
                </div>
                <div className={`rounded-xl p-3 ${darkMode ? 'bg-zinc-800/50' : 'bg-gray-100'}`}>
                  <div className="text-2xl font-bold text-pink-500">{stats.totalDistance}</div>
                  <div className={`text-xs ${darkMode ? 'text-zinc-500' : 'text-gray-500'}`}>km total</div>
                </div>
                <div className={`rounded-xl p-3 ${darkMode ? 'bg-zinc-800/50' : 'bg-gray-100'}`}>
                  <div className="text-2xl font-bold text-violet-500">{stats.totalElevation}</div>
                  <div className={`text-xs ${darkMode ? 'text-zinc-500' : 'text-gray-500'}`}>m elevation</div>
                </div>
                <div className={`rounded-xl p-3 ${darkMode ? 'bg-zinc-800/50' : 'bg-gray-100'}`}>
                  <div className="text-2xl font-bold text-amber-500">
                    {stats.totalTime > 0 ? formatDuration(stats.totalTime) : '—'}
                  </div>
                  <div className={`text-xs ${darkMode ? 'text-zinc-500' : 'text-gray-500'}`}>time</div>
                </div>
              </div>
            </div>
          )}

          {/* Routes List - with its own scrollbar */}
          <div className={`rounded-2xl overflow-hidden ${darkMode ? 'bg-zinc-900/50 border border-zinc-800' : 'bg-white border border-gray-200'}`}>
            <div className={`p-4 flex items-center justify-between ${darkMode ? 'border-zinc-800' : 'border-gray-200'}`} style={{ borderBottomWidth: 1 }}>
              <h2 className="font-medium">Your Routes</h2>
              <span className={`text-xs ${darkMode ? 'text-zinc-500' : 'text-gray-500'}`}>
                {filteredRoutes.length !== routes.length 
                  ? `${filteredRoutes.length} / ${routes.length} routes` 
                  : `${routes.length} routes`}
              </span>
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
                {getDisplayRoutes().map((route, index) => (
                  <div
                    key={route.id}
                    onClick={() => { setSelectedRoute(route); setSuggestedRoute(null); }}
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

        {/* Map - takes remaining space, doesn't shrink */}
        <div className="flex-1 flex flex-col min-h-[300px] md:min-h-0 flex-shrink-0">
          {/* Suggested Route Info Panel */}
          {suggestedRoute && (
            <div className="mb-4 p-4 bg-gradient-to-r from-pink-500/10 to-violet-500/10 border border-pink-500/30 rounded-xl">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <h3 className="font-bold text-pink-400">{suggestedRoute.name}</h3>
                  <div className="flex gap-4 mt-1 text-sm text-zinc-400">
                    <span>📏 {(suggestedRoute.distance / 1000).toFixed(1)} km</span>
                    <span>⬆️ {suggestedRoute.elevationGain}m elevation</span>
                    <span title="How much of this route overlaps with your previous runs">
                      {suggestedRoute.familiarityScore !== undefined 
                        ? `🔄 ${suggestedRoute.familiarityScore}% familiar`
                        : (avoidFamiliar ? "🆕 New paths" : "🔄 Familiar paths")}
                    </span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => downloadGPX(suggestedRoute)}
                    className="px-3 py-2 bg-pink-500 hover:bg-pink-400 text-white text-sm rounded-lg transition-colors flex items-center gap-2"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    Download GPX
                  </button>
                  <button
                    onClick={discardSuggestion}
                    className="px-3 py-2 bg-zinc-700 hover:bg-zinc-600 text-white text-sm rounded-lg transition-colors"
                  >
                    Discard
                  </button>
                </div>
              </div>
            </div>
          )}
          
          <div className={`flex-1 ${darkMode ? 'bg-zinc-900' : 'bg-gray-200'} border ${darkMode ? 'border-zinc-800' : 'border-gray-300'} rounded-2xl overflow-hidden`}>
            {routes.length > 0 || suggestedRoute ? (
              <MapWithNoSSR
                routes={suggestedRoute ? [] : getDisplayRoutes()}
                selectedRoute={selectedRoute}
                showHeatmap={showHeatmap}
                suggestedRoute={suggestedRoute}
                selectedStartPoint={selectedStartPoint}
                onMapClick={handleMapClick}
                isSelectingStartPoint={isSelectingStartPoint}
                darkMode={darkMode}
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
