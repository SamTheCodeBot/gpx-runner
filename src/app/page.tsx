"use client";

import { useState, useRef, useMemo, useEffect } from "react";
import { useAuth, logout } from "@/lib/auth";
import { downloadGPXFile } from "@/lib/utils";
import { routeCountryNames } from "@/lib/countries";
import { useGPXRoutes, useRouteStats, useRouteFilter, useUnifiedRoutes, useUserProfile, useFavorites } from "@/lib/hooks";
import { Icon, EditModal, UploadModal, LoginScreen } from "@/components/ui";
import { termsAcknowledgement, privacyJson, useIntervalsConnection } from "@/lib/privacy";
import { StatsBar } from "@/components/StatsBar";
import { Sidebar, MobileDrawer } from "@/components/Sidebar";
import { RouteList } from "@/components/RouteList";
import { MapSection } from "@/components/MapSection";
import type { GPXRoute } from "./types";
import type { MapViewBounds } from "@/components/Map";

/**
 * Whether any point of a route falls inside the map's current viewport.
 * Coordinates are [lon, lat]; bounds come straight off Leaflet's own
 * getBounds(). Handles the antimeridian (west > east) the cheap way --
 * good enough for "is this on screen", not a general geometry library.
 */
function routeIntersectsBounds(route: GPXRoute, bounds: MapViewBounds): boolean {
  const { south, west, north, east } = bounds;
  const crossesAntimeridian = west > east;
  for (const [lon, lat] of route.coordinates) {
    if (lat < south || lat > north) continue;
    const lonInRange = crossesAntimeridian ? (lon >= west || lon <= east) : (lon >= west && lon <= east);
    if (lonInRange) return true;
  }
  return false;
}

export default function Home() {
  const { user, loading: authLoading } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Auth UI state ───────────────────────────────────────────────────────────
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError]   = useState("");
  const [authSuccess, setAuthSuccess] = useState("");
  const [isRegistering, setIsRegistering]       = useState(false);
  const [showForgotPassword, setShowForgotPassword] = useState(false);

  // ── Core data ───────────────────────────────────────────────────────────────
  // `routes` is storage: the route documents this page may upload to, rename and
  // delete. Every mutation below keeps using it.
  // loadFullGeometry: false -- the only page-specific knob standing between
  // Magnus's phone and iOS Safari's memory-pressure crash (confirmed twice,
  // 2026-10-03 and 2026-10-04, on a real iPhone, with every run's full GPS
  // track held in memory at once, however gently the decode was chunked).
  // Home's overview now runs permanently on the thinned (<=120 point) track
  // routes/summaries already provides; selecting one route fetches that
  // route's full geometry on demand via fetchFullRoute, below. If the
  // summaries endpoint fails for any reason, useGPXRoutes falls back to the
  // full decode itself -- this can only ever be as safe as before, never
  // worse, regardless of whether that endpoint is healthy.
  const { routes, saveRoutes, uploadFiles, deleteRoute, updateRoute, loading: isUploading, fetchFullRoute } = useGPXRoutes(user?.uid ?? null, { loadFullGeometry: false });
  // `unifiedRoutes` is display: the same routes plus provider-synced activities,
  // deduped and labelled with where each run came from. Read-only.
  const { routes: unifiedRoutes } = useUnifiedRoutes(user?.uid ?? null, routes);

  // ── UI state ────────────────────────────────────────────────────────────────
  const [selectedRoute, setSelectedRoute] = useState<GPXRoute | null>(null);
  const [showHeatmap, setShowHeatmap]      = useState(true);
  const [showPersonalHeatmap, setShowPersonalHeatmap] = useState(false);
  const [editingRoute, setEditingRoute]    = useState<GPXRoute | null>(null);
  const [pendingUploads, setPendingUploads] = useState<GPXRoute[]>([]);
  const pendingUpload = pendingUploads[0] ?? null;
  const [showDrawer, setShowDrawer]          = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery]       = useState("");
  const [showFilters, setShowFilters]      = useState(false);
  const [filter, setFilter]                = useState<{ year?: string; month?: string; type?: string; country?: string; list?: "all" | "favorites" }>({});
  const [username, setUsername]             = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [routesPanelCollapsed, setRoutesPanelCollapsed] = useState(false);
  /**
   * Set by clicking a route's line on the map. Narrows the list to just the
   * route(s) whose line passed under the click -- the map is the only way to
   * find an old route you can picture the shape of but can't place in a list
   * sorted and paged by date. More than one id means several routes overlap
   * at that exact spot (the same loop run many times); exactly one means the
   * click already identified it, so it's selected immediately, same as
   * clicking it in the list would.
   */
  const [mapRouteMatchIds, setMapRouteMatchIds] = useState<string[] | null>(null);
  /**
   * The map's current viewport, kept live by Map's onBoundsChange. Lets the
   * list follow the map instead of the other way around: pan to Barcelona,
   * flip "In view" on, and the list narrows to whatever is actually on
   * screen -- without ever asking the map to move to match the list.
   */
  const [mapBounds, setMapBounds] = useState<MapViewBounds | null>(null);
  const [filterByMapView, setFilterByMapView] = useState(false);

  // ── Derived ────────────────────────────────────────────────────────────────
  const { favorites, toggleFavorite } = useFavorites(user?.uid ?? null);
  const listFilteredRoutes = useMemo(() => {
    if (filter.list === "favorites") return unifiedRoutes.filter((route) => favorites.includes(route.id));
    return unifiedRoutes;
  }, [unifiedRoutes, filter.list, favorites]);
  // `filteredRoutes` also drives what the map draws and fits to, so a map
  // click narrowing the ROUTE LIST must never narrow this -- otherwise
  // clearing that narrowing changes the map's own route set, which moves
  // the camera back out to fit everything (reported 2026-10-08: "zooms back
  // to Falkenberg"). The map-click narrowing is display-list-only; see
  // `routeListDisplay` below.
  const filteredRoutes = useRouteFilter(listFilteredRoutes, filter, searchQuery);
  // What the route LIST actually renders: filteredRoutes, further narrowed
  // to the candidates a map click matched, if any. The map itself never
  // sees this narrower set -- only the list does -- so clearing it back to
  // null is purely a list-side change and never moves the camera.
  const routeListDisplay = useMemo(() => {
    let out = filteredRoutes;
    if (mapRouteMatchIds) {
      const matchSet = new Set(mapRouteMatchIds);
      out = out.filter((route) => matchSet.has(route.id));
    }
    if (filterByMapView && mapBounds) {
      out = out.filter((route) => routeIntersectsBounds(route, mapBounds));
    }
    return out;
  }, [filteredRoutes, mapRouteMatchIds, filterByMapView, mapBounds]);
  const { profile, saveProfile, loading } = useUserProfile(user?.uid ?? null);

  // ── intervals.icu auto-import ──────────────────────────────────────────────
  // Opt-in, per the checkbox on the intervals.icu settings card
  // (profile.intervalsIcu.autoImport). When it is on and the provider is
  // actually connected, pull the last 30 days once per visit -- same request
  // the manual "Sync last 30 days" button makes, just fired for the user
  // instead of waiting for a click. Never runs ahead of consent: a profile
  // flag alone cannot start a connection, only skip asking twice for a sync
  // the user already agreed to.
  const { data: intervalsConnectState } = useIntervalsConnection();
  const autoImportRanRef = useRef(false);
  useEffect(() => {
    if (autoImportRanRef.current) return;
    if (!user || loading) return;
    if (!profile?.intervalsIcu?.autoImport) return;
    if (!intervalsConnectState?.connection) return;
    autoImportRanRef.current = true;
    privacyJson(user, "/api/intervals/sync", {
      method: "POST",
      body: JSON.stringify({ mode: "recent" }),
    }).catch((e) => {
      // Silent by design: this is a convenience prefetch, not a user action.
      // The intervals.icu card on the profile page still shows last-sync
      // status and lets them retry by hand.
      console.error("[auto-import] intervals.icu sync failed", e);
    });
  }, [user, loading, profile?.intervalsIcu?.autoImport, intervalsConnectState?.connection]);

  const stats = useMemo(() => {
    if (!routeListDisplay.length) return null;
    const totalDistance = routeListDisplay.reduce((s, r) => s + (r.distance || 0), 0) / 1000;
    const totalElevation = routeListDisplay.reduce((s, r) => s + (r.elevationGain || 0), 0);
    return {
      totalRuns: routeListDisplay.length,
      totalDistance: Math.round(totalDistance * 10) / 10,
      totalElevation: Math.round(totalElevation),
      totalTime: 0,
    };
  }, [routeListDisplay]);

  const countryOptions = useMemo(() => (
    Array.from(new Set(unifiedRoutes.flatMap((route) => routeCountryNames(route)))).sort((a, b) => a.localeCompare(b))
  ), [unifiedRoutes]);

  // ── Handlers ───────────────────────────────────────────────────────────────
  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(""); setAuthSuccess("");
    if (showForgotPassword) {
      const { resetPassword: rp } = await import("@/lib/auth");
      try { await rp(email); setAuthSuccess("✓ Check your email"); setShowForgotPassword(false); }
      catch (err: any) { setAuthError(err.message || "Failed"); }
      return;
    }
    try {
      const { login: lg, register: reg } = await import("@/lib/auth");
      if (isRegistering) {
        if (!username.trim() || username.trim().length < 3) {
          setAuthError("Please choose a username (at least 3 characters).");
          return;
        }
        const { db } = await import("@/lib/firebase");
        if (db) {
          const { getDocs, query, collection, where } = await import("firebase/firestore");
          const snap = await getDocs(query(collection(db, "userProfiles"), where("username", "==", username.trim())));
          if (!snap.empty) {
            setAuthError(`The username "${username.trim()}" is already taken. Please choose another.`);
            return;
          }
        }
        await reg(email, password);
        // Terms acknowledgement stamped with its version. Contract basis
        // (Art. 6(1)(b)) — this is not, and must not be read as, consent to
        // pull data from any provider.
        await saveProfile({
          username: username.trim(),
          displayName: username.trim(),
          ...termsAcknowledgement(),
        });
        setUsername("");
      } else {
        await lg(email, password);
      }
      setEmail(""); setPassword("");
    } catch (err: any) { setAuthError(err.message || "Auth failed"); }
  };

  const handleLogout = async () => {
    await logout();
    saveRoutes([]);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const newRoutes = await uploadFiles(files, routes);
    if (newRoutes.length > 0) {
      setPendingUploads(newRoutes);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleRouteUpload = async (gpxFiles: File[], tcxFiles: File[]) => {
    if (!gpxFiles.length) return;
    if (tcxFiles.length > 0) {
      console.info("[route upload] TCX files selected for future metrics import", tcxFiles.map((file) => file.name));
    }
    const newRoutes = await uploadFiles(gpxFiles, routes, tcxFiles);
    if (newRoutes.length > 0) {
      setPendingUploads(newRoutes);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const acceptUpload = async (name: string, type: string) => {
    if (!pendingUpload) return;
    const named: GPXRoute = { ...pendingUpload, name, type: type as "road" | "trail" | "mixed" };
    saveRoutes([...routes, named]);
    setSelectedRoute(named);
    setPendingUploads((pending) => pending.slice(1));
    if (named.id && user?.uid) {
      const { doc, updateDoc } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      if (db) updateDoc(doc(db, "routes", named.id), { name, type }).catch(console.error);
    }
  };

  const cancelUpload = () => {
    setPendingUploads((pending) => pending.slice(1));
  };

  const handleDeleteRoute = (id: string) => {
    deleteRoute(id, routes);
    if (selectedRoute?.id === id) setSelectedRoute(null);
  };

  const handleUpdateRoute = (id: string, name: string, type: string) => {
    updateRoute(id, name, type, routes);
    if (selectedRoute && selectedRoute.id === id) setSelectedRoute({ ...selectedRoute, name, type: type as "road" | "trail" | "mixed" | undefined });
    setEditingRoute(null);
  };

  /**
   * Home's overview geometry is thinned (<=120 points) and permanent --
   * selecting a route swaps in that one route's full-resolution geometry on
   * demand, for precise km markers and path detail, without ever holding
   * every route's full geometry in memory at once. Falls back to the
   * thinned version already in `route` if the fetch fails for any reason.
   */
  const selectRouteWithFullGeometry = async (route: GPXRoute | null) => {
    setSelectedRoute(route);
    if (!route) return;
    const full = await fetchFullRoute(route.id);
    if (full) setSelectedRoute((current) => (current?.id === route.id ? full : current));
  };

  const handleDownload = (route: GPXRoute) => downloadGPXFile(route);

  const handleToggleFavorite = async (routeId: string) => {
    await toggleFavorite(routeId);
  };

  const handleMapClick = () => {
    // No-op — kept for compatibility with MapSection interface
  };

  /**
   * Clicking a route's line on the map. One match behaves exactly like
   * clicking that route in the list -- select it, fetch its full geometry.
   * More than one match (several routes overlapping at that exact spot, e.g.
   * the same loop run on different days) narrows the list to just those
   * candidates instead of guessing, so an old route buried past page 1 of a
   * long history is never more than a map click plus one more click away.
   */
  const handleMapRouteClick = (matches: GPXRoute[]) => {
    if (matches.length === 0) return;
    if (matches.length === 1) {
      setMapRouteMatchIds(null);
      selectRouteWithFullGeometry(matches[0]);
    } else {
      setSelectedRoute(null);
      setMapRouteMatchIds(matches.map((route) => route.id));
    }
  };

  const clearMapRouteMatch = () => setMapRouteMatchIds(null);

  const handleSearchChange = (q: string) => {
    if (mapRouteMatchIds) setMapRouteMatchIds(null);
    setSearchQuery(q);
  };

  const handleFilterChange = (f: typeof filter) => {
    if (mapRouteMatchIds) setMapRouteMatchIds(null);
    setFilter(f);
  };

  const getYearOptions = () =>
    Array.from(new Set(unifiedRoutes.map((r) => r.date.substring(0, 4)).filter(Boolean))).sort().reverse();

  const getMonthOptions = () =>
    Array.from(new Set(unifiedRoutes.map((r) => r.date.substring(5, 7)).filter(Boolean))).sort((a, b) => Number(a) - Number(b));

  // ── Render ───────────────────────────────────────────────────────────────
  if (authLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-on-surface-variant text-sm">Loading&hellip;</div>
      </div>
    );
  }

  if (!user) {
    return (
      <LoginScreen
        email={email} setEmail={setEmail}
        username={username} setUsername={setUsername}
        password={password} setPassword={setPassword}
        authError={authError} authSuccess={authSuccess}
        isRegistering={isRegistering} setIsRegistering={setIsRegistering}
        showForgotPassword={showForgotPassword} setShowForgotPassword={setShowForgotPassword}
        handleAuth={handleAuth}
        setAuthError={setAuthError}
      />
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Desktop sidebar */}
      <Sidebar
        user={user}
        profile={profile}
        profileLoading={loading}
        onLogout={handleLogout}
        fileInputRef={fileInputRef}
        onFileUpload={handleFileUpload}
        onRouteUpload={handleRouteUpload}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((collapsed) => !collapsed)}
      />

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile header */}
        <header className="md:hidden h-14 bg-surface-container-lowest border-b border-outline-variant/10 flex items-center justify-between px-4 shrink-0 z-20">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-primary-container flex items-center justify-center">
              <Icon name="sprint" filled className="text-on-primary-container text-sm" />
            </div>
            <span className="text-sm font-extrabold text-primary font-headline">GPX running</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setMobileSearchOpen(true)}
              className="p-2 -mr-1 rounded-xl hover:bg-surface-container transition-colors"
            >
              <Icon name="search" className="text-on-surface-variant text-lg" />
            </button>
            <button onClick={() => setShowDrawer(true)} className="p-2 -mr-2 rounded-xl hover:bg-surface-container transition-colors">
              <Icon name="menu" className="text-on-surface-variant text-xl" />
            </button>
          </div>
        </header>

        {/* Body: side-by-side desktop / stacked mobile */}
        <div className="flex-1 flex flex-col md:flex-row overflow-hidden">

          {/* ── Routes panel ── */}
          <div
            className={`flex-1 overflow-y-auto px-4 pt-5 pb-4 md:pt-4 space-y-5 custom-scrollbar order-2 md:order-none transition-all duration-300 ease-out ${routesPanelCollapsed ? "md:flex-none md:w-0 md:p-0 md:opacity-0 md:pointer-events-none" : "md:p-6 md:opacity-100"}`}
          >

            <StatsBar stats={stats} />

            {mapRouteMatchIds && (
              <div className="flex items-center justify-between gap-2 px-3 py-2 bg-primary-container/60 border border-primary-container rounded-xl text-xs">
                <span className="font-medium text-on-primary-container">
                  <Icon name="my_location" className="text-xs align-middle mr-1" />
                  {mapRouteMatchIds.length === 1
                    ? "Showing the route you clicked on the map"
                    : "Showing " + mapRouteMatchIds.length + " routes that pass through where you clicked"}
                </span>
                <button
                  onClick={clearMapRouteMatch}
                  className="font-bold text-primary hover:underline shrink-0"
                >
                  Clear
                </button>
              </div>
            )}

            <RouteList
              filteredRoutes={routeListDisplay}
              selectedRoute={selectedRoute}
              searchQuery={searchQuery}
              onSearchChange={handleSearchChange}
              showFilters={showFilters}
              filter={filter}
              setFilter={handleFilterChange}
              setShowFilters={setShowFilters}
              filterByMapView={filterByMapView}
              onToggleFilterByMapView={() => setFilterByMapView((v) => !v)}
              getYearOptions={getYearOptions}
              getMonthOptions={getMonthOptions}
              countryOptions={countryOptions}
              onSelectRoute={selectRouteWithFullGeometry}
              onDeleteRoute={handleDeleteRoute}
              onDownloadRoute={handleDownload}
              onEditRoute={setEditingRoute}
              fileInputRef={fileInputRef}
              onFileUpload={handleFileUpload}
              onRouteUpload={handleRouteUpload}
              favorites={favorites}
              onToggleFavorite={handleToggleFavorite}
            />
          </div>

          {/* ── Map panel ── */}
          <div className={`w-full order-1 md:order-none relative transition-all duration-300 ease-out ${routesPanelCollapsed ? "md:flex-1" : "md:w-1/2 md:shrink-0"}`}>
            {/* Floating search overlay on mobile */}
            {mobileSearchOpen && (
              <div className="absolute top-2 left-2 right-2 z-30 flex items-center gap-2 md:hidden">
                <input
                  autoFocus
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Escape") { setMobileSearchOpen(false); setSearchQuery(""); }}}
                  placeholder="Search routes..."
                  className="flex-1 pl-4 pr-3 py-2 bg-surface-container-lowest/95 backdrop-blur-md border border-outline-variant rounded-2xl text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/30 shadow-lg"
                />
                <button
                  onClick={() => { setMobileSearchOpen(false); setSearchQuery(""); }}
                  className="p-2 bg-surface-container-lowest/95 backdrop-blur-md rounded-xl shadow-lg hover:bg-surface-container transition-colors"
                >
                  <Icon name="close" className="text-on-surface-variant text-base" />
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={() => setRoutesPanelCollapsed((collapsed) => !collapsed)}
              className="hidden md:flex absolute top-6 left-0 z-30 h-10 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-outline-variant/40 bg-surface-container-lowest text-primary shadow-card hover:bg-surface-container transition-colors"
              title={routesPanelCollapsed ? "Show route list" : "Hide route list"}
              aria-label={routesPanelCollapsed ? "Show route list" : "Hide route list"}
            >
              <Icon name={routesPanelCollapsed ? "chevron_right" : "chevron_left"} className="text-lg" />
            </button>

            {/*
             * h-[45vh], not h-52/h-64: Street Projects already sized its own
             * mobile map at 45% of viewport height, and the owner asked for
             * Home to match it -- this page\u0027s fixed 13rem/16rem was simply
             * much smaller on a phone than the equivalent page elsewhere in
             * the app, for no reason tied to this page\u0027s own layout.
             */}
            <div className="h-[45vh] md:h-full p-4 md:pr-6 md:pt-6 md:pb-4">
              <MapSection
                routes={filteredRoutes}
                selectedRoute={selectedRoute}
                suggestedRoute={null}
                showHeatmap={showHeatmap}
                fitAllRoutes={Boolean(filter.country)}
                showPersonalHeatmap={showPersonalHeatmap}
                onToggleHeatmap={() => setShowHeatmap(!showHeatmap)}
                showHeatmapToggle={false}
                onTogglePersonalHeatmap={() => setShowPersonalHeatmap(!showPersonalHeatmap)}
                isLoading={isUploading}
                selectedStartPoint={null}
                isSelectingStartPoint={false}
                onMapClick={handleMapClick}
                onRouteClick={handleMapRouteClick}
                onBoundsChange={setMapBounds}
                showPersonalHeatmapControl={false}
              />
            </div>

            {/* Mobile map controls below map */}
            <div className="flex md:hidden items-center justify-between px-4 pt-3 pb-1">
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "rgb(255 65 164)" }} />
                  <span className="text-[9px] text-on-surface-variant">Road</span>
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "rgb(18 221 251)" }} />
                  <span className="text-[9px] text-on-surface-variant">Trail</span>
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "rgb(197 45 255)" }} />
                  <span className="text-[9px] text-on-surface-variant">Mixed</span>
                </div>
                {showPersonalHeatmap && (
                  <div className="flex items-center gap-1">
                    <div
                      className="w-4 h-2 rounded-full"
                      style={{ background: "linear-gradient(90deg, rgb(255 190 224), rgb(255 65 164), rgb(151 17 86))" }}
                    />
                    <span className="text-[9px] text-on-surface-variant">Freq</span>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setShowPersonalHeatmap(!showPersonalHeatmap)}
                  className={`px-2 py-1 rounded-lg text-[10px] font-bold transition-colors ${
                    showPersonalHeatmap
                      ? "bg-primary text-on-primary"
                      : "bg-surface-container text-on-surface-variant hover:bg-surface-container-high"
                  }`}
                >
                  <Icon name="whatshot" className="text-[10px] inline mr-0.5" />
                  {showPersonalHeatmap ? "Freq" : "Freq"}
                </button>

              </div>
            </div>
          </div>

        </div>

        {/* Mobile drawer */}
        <MobileDrawer
          isOpen={showDrawer}
          onClose={() => setShowDrawer(false)}
          user={user}
          profile={profile}
          profileLoading={loading}
          onLogout={handleLogout}
          fileInputRef={fileInputRef}
          onFileUpload={handleFileUpload}
          onRouteUpload={handleRouteUpload}
        />
      </main>

      {/* Edit modal */}
      {editingRoute && (
        <EditModal
          route={editingRoute}
          onSave={(name, type) => handleUpdateRoute(editingRoute.id, name, type)}
          onClose={() => setEditingRoute(null)}
          onDelete={() => handleDeleteRoute(editingRoute.id)}
        />
      )}

      {/* Post-upload naming modal */}
      {pendingUpload && (
        <UploadModal
          key={pendingUpload.id}
          route={pendingUpload}
          onAccept={acceptUpload}
          onCancel={cancelUpload}
        />
      )}
    </div>
  );
}
