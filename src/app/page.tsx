"use client";

import { useState, useRef, useMemo } from "react";
import { useAuth, logout } from "@/lib/auth";
import { downloadGPXFile } from "@/lib/utils";
import { useGPXRoutes, useRouteStats, useRouteFilter, useRouteSuggestions, useUserProfile, useWishlist, useFavorites } from "@/lib/hooks";
import { Icon, EditModal, UploadModal, LoginScreen } from "@/components/ui";
import { StatsBar } from "@/components/StatsBar";
import { Sidebar, MobileDrawer } from "@/components/Sidebar";
import { RouteList } from "@/components/RouteList";
import { MapSection } from "@/components/MapSection";
import type { GPXRoute } from "./types";

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
  const { routes, saveRoutes, uploadFiles, deleteRoute, updateRoute, loading: isUploading } = useGPXRoutes(user?.uid ?? null);

  // ── UI state ────────────────────────────────────────────────────────────────
  const [selectedRoute, setSelectedRoute] = useState<GPXRoute | null>(null);
  const [showHeatmap, setShowHeatmap]      = useState(true);
  const [editingRoute, setEditingRoute]    = useState<GPXRoute | null>(null);
  const [pendingUpload, setPendingUpload]   = useState<GPXRoute | null>(null);
  const [showDrawer, setShowDrawer]          = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery]       = useState("");
  const [showFilters, setShowFilters]      = useState(false);
  const [filter, setFilter]                = useState<{ month?: string; type?: string; list?: "all" | "favorites" | "wishlist" }>({});
  const [selectedStartPoint, setSelectedStartPoint] = useState<[number, number] | null>(null);
  const [isSelectingStartPoint, setIsSelectingStartPoint] = useState(false);
  const [suggestDistance, setSuggestDistance] = useState(5);
  const [avoidFamiliar, setAvoidFamiliar]   = useState(true);
  const [selectedType, setSelectedType]   = useState<"road" | "trail" | "mixed">("mixed");
  const [showSuggestPanel, setShowSuggestPanel] = useState(false);
  const [username, setUsername]             = useState("");

  // ── Derived ────────────────────────────────────────────────────────────────
  const filteredRoutes = useRouteFilter(routes, filter, searchQuery);
  const { profile, saveProfile, loading } = useUserProfile(user?.uid ?? null);

  const stats = useMemo(() => {
    if (!filteredRoutes.length) return null;
    const totalDistance = filteredRoutes.reduce((s, r) => s + (r.distance || 0), 0) / 1000;
    const totalElevation = filteredRoutes.reduce((s, r) => s + (r.elevationGain || 0), 0);
    return {
      totalRuns: filteredRoutes.length,
      totalDistance: Math.round(totalDistance * 10) / 10,
      totalElevation: Math.round(totalElevation),
      totalTime: 0,
    };
  }, [filteredRoutes]);

  const { suggestedRoute, isSuggesting, apiKeyMissing, getSuggestion, clearSuggestion } =
    useRouteSuggestions(suggestDistance, avoidFamiliar);
  const { wishlist, toggleWishlist } = useWishlist(user?.uid ?? null);
  const { favorites, toggleFavorite } = useFavorites(user?.uid ?? null);

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
        // Duplicate check before creating account
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
        // Create profile immediately with chosen username
        await saveProfile({ username: username.trim(), displayName: username.trim() });
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
      setPendingUpload(newRoutes[0]);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const acceptUpload = (name: string, type: string) => {
    if (!pendingUpload) return;
    const named: GPXRoute = { ...pendingUpload, name, type: type as "road" | "trail" | "mixed" };
    saveRoutes([...routes, named]);
    setSelectedRoute(named);
    setPendingUpload(null);
    // Update Firestore with the corrected type (uploadFiles saved it as "road")
    if (named.id && user?.uid) {
      const { doc, updateDoc } = require("firebase/firestore");
      const { db } = require("@/lib/firebase");
      if (db) updateDoc(doc(db, "routes", named.id), { name, type }).catch(console.error);
    }
  };

  const cancelUpload = () => {
    setPendingUpload(null);
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

  const handleDownload = (route: GPXRoute) => downloadGPXFile(route);

  const handleMapClick = (lat: number, lon: number) => {
    if (isSelectingStartPoint) {
      setSelectedStartPoint([lon, lat]);
      setIsSelectingStartPoint(false);
    }
  };

  const handleSaveToWishlist = async (route: GPXRoute) => {
    await toggleWishlist(route.id);
  };


  const handleSaveSuggestedToWishlist = async () => {
    if (!suggestedRoute) return;
    await toggleWishlist(suggestedRoute.id);
  };

  const handleToggleFavorite = async (route: GPXRoute) => {
    await toggleFavorite(route.id);
  };

  const handleGenerate = () => {
    getSuggestion(selectedStartPoint, routes);
  };

  const getMonthOptions = () =>
    Array.from(new Set(routes.map((r) => r.date.substring(0, 7)))).sort().reverse();

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

  // ── Desktop: side-by-side flex (no reversal) ─────────────────────────────
  // Routes left (flex-1, scrollable) | Map right (w-1/2, fixed height)
  // Mobile: column flex — map at top (fixed height), routes below (scrollable)
  // activeTab controls which panel is visible on mobile (map tab = map only; routes tab = routes only)
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
      />

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="h-14 bg-surface-container-lowest border-b border-outline-variant/10 flex items-center justify-between px-4 md:px-8 shrink-0 z-20 md:hidden">
          <div className="flex items-center gap-3">
            <div className="md:hidden flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-primary-container flex items-center justify-center">
                <Icon name="sprint" filled className="text-on-primary-container text-sm" />
              </div>
              <span className="text-sm font-extrabold text-primary font-headline">GPX running</span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
                onClick={() => setMobileSearchOpen(true)}
                className="md:hidden p-2 -mr-1 rounded-xl hover:bg-surface-container transition-colors"
              >
                <Icon name="search" className="text-on-surface-variant text-lg" />
              </button>

            {/* Mobile: hamburger menu (right side) */}
            <button onClick={() => setShowDrawer(true)} className="md:hidden p-2 -mr-2 rounded-xl hover:bg-surface-container transition-colors">
              <Icon name="menu" className="text-on-surface-variant text-xl" />
            </button>
          </div>
        </header>

        {/* Desktop: side-by-side | Mobile: tab-switched panels */}
        <div className="flex-1 flex flex-col md:flex-row overflow-hidden">

          {/* ── Routes panel ── */}
          <div className={
            "flex-1 overflow-y-auto px-4 pt-5 pb-4 md:p-6 md:pt-4 space-y-5 custom-scrollbar order-2 md:order-none"
          }>
            {/* ── Route Suggestions panel ── */}
            <div className="bg-surface-container border border-outline-variant/20 rounded-2xl overflow-hidden">
              {/* Panel header — always visible */}
              <button
                className="w-full flex items-center justify-between p-4 hover:bg-surface-container-high transition-colors"
                onClick={() => setShowSuggestPanel(p => !p)}
              >
                <div className="flex items-center gap-2">
                  <Icon name="explore" className="text-primary text-lg" />
                  <span className="text-sm font-extrabold text-primary">Route Suggestions</span>
                </div>
                <Icon name={showSuggestPanel ? "expand_less" : "expand_more"} className="text-on-surface-variant" />
              </button>

              {/* Collapsible settings + result area */}
              {showSuggestPanel && (
                <div className="px-4 pb-4 space-y-4">

                  {/* Settings */}
                  <div className="space-y-3">
                    {/* Distance */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-on-surface-variant">Distance</span>
                        <span className="text-xs font-bold text-primary">{suggestDistance} km</span>
                      </div>
                      <input
                        type="range" min={1} max={30} step={0.5}
                        value={suggestDistance}
                        onChange={e => setSuggestDistance(parseFloat(e.target.value))}
                        className="w-full accent-primary"
                      />
                    </div>

                    {/* Type */}
                    <div>
                      <div className="mb-1.5">
                        <span className="text-xs font-medium text-on-surface-variant">Route Type</span>
                      </div>
                      <div className="flex gap-2">
                        {(["road", "trail", "mixed"] as const).map(t => (
                          <button key={t}
                            onClick={() => setSelectedType(t)}
                            className={`flex-1 py-1.5 rounded-xl text-xs font-bold capitalize transition-colors ${
                              selectedType === t
                                ? t === "road" ? "bg-pink-100 text-pink-700"
                                  : t === "trail" ? "bg-cyan-100 text-cyan-700"
                                  : "bg-purple-100 text-purple-700"
                                : "bg-surface-container-high text-on-surface-variant hover:bg-surface-container-low"
                            }`}
                          >{t}</button>
                        ))}
                      </div>
                    </div>

                    {/* Familiar / Novel toggle */}
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-medium text-on-surface-variant w-16">Mode</span>
                      <button
                        onClick={() => setAvoidFamiliar(false)}
                        className={`flex-1 py-1.5 rounded-xl text-xs font-bold transition-colors ${
                          !avoidFamiliar ? "bg-primary-container text-on-primary-container" : "bg-surface-container-high text-on-surface-variant"
                        }`}
                      >🏠 Familiar</button>
                      <button
                        onClick={() => setAvoidFamiliar(true)}
                        className={`flex-1 py-1.5 rounded-xl text-xs font-bold transition-colors ${
                          avoidFamiliar ? "bg-primary-container text-on-primary-container" : "bg-surface-container-high text-on-surface-variant"
                        }`}
                      >🧭 Novel</button>
                    </div>

                    {/* Start point */}
                    <div>
                      <div className="mb-1.5">
                        <span className="text-xs font-medium text-on-surface-variant">Start Point</span>
                      </div>
                      {selectedStartPoint ? (
                        <div className="flex items-center gap-2">
                          <div className="flex-1 px-3 py-1.5 bg-surface-container-high rounded-xl text-xs text-on-surface">
                            {selectedStartPoint[1].toFixed(4)}, {selectedStartPoint[0].toFixed(4)}
                          </div>
                          <button onClick={() => { setSelectedStartPoint(null); setIsSelectingStartPoint(true); }}
                            className="px-3 py-1.5 bg-surface-container-high hover:bg-surface-container-low rounded-xl text-xs font-medium text-on-surface-variant transition-colors">
                            Change
                          </button>
                        </div>
                      ) : (
                        <button onClick={() => setIsSelectingStartPoint(true)}
                          className="w-full py-2 bg-primary-container text-on-primary-container rounded-xl text-xs font-bold hover:opacity-90 transition-opacity">
                          📍 Pick on Map
                        </button>
                      )}
                      {isSelectingStartPoint && (
                        <p className="mt-1.5 text-xs text-primary font-medium animate-pulse">
                          ↖ Click anywhere on the map to set the start point
                        </p>
                      )}
                    </div>

                    {/* Generate button */}
                    <button
                      onClick={handleGenerate}
                      disabled={isSuggesting}
                      className="w-full py-2.5 bg-primary text-on-primary rounded-xl text-sm font-bold hover:opacity-90 disabled:opacity-50 transition-opacity flex items-center justify-center gap-2"
                    >
                      {isSuggesting ? (
                        <><Icon name="progress_activity" className="text-sm animate-spin" /> Generating&hellip;</>
                      ) : (
                        <><Icon name="sprint" className="text-sm" /> Generate Route</>
                      )}
                    </button>
                  </div>

                  {/* Generated route result */}
                  {suggestedRoute && (
                    <div className="bg-primary-container/10 border border-primary-container/30 rounded-2xl p-4 animate-fade-in">
                      <div className="flex items-center gap-2 mb-2">
                        <Icon name="check_circle" filled className="text-secondary text-base" />
                        <span className="text-[10px] font-extrabold uppercase tracking-wider text-secondary">Generated Route</span>
                        {suggestedRoute.type && (
                          <span className={`ml-auto text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
                            suggestedRoute.type === "road" ? "bg-pink-100 text-pink-700" :
                            suggestedRoute.type === "trail" ? "bg-cyan-100 text-cyan-700" :
                            "bg-purple-100 text-purple-700"
                          }`}>{suggestedRoute.type}</span>
                        )}
                      </div>
                      <h4 className="text-base font-extrabold text-primary">{suggestedRoute.name}</h4>
                      <p className="text-xs text-on-surface-variant mt-0.5">
                        {(suggestedRoute.distance / 1000).toFixed(1)} km
                        {suggestedRoute.elevationGain > 0 && ` · +${suggestedRoute.elevationGain}m`}
                      </p>
                      <div className="mt-3 flex items-center gap-2">
                        <button onClick={handleGenerate} disabled={isSuggesting}
                          className="flex-1 py-2 bg-primary-container hover:bg-primary-container/70 text-on-primary-container rounded-xl text-xs font-bold transition-colors flex items-center justify-center gap-1.5">
                          <Icon name="refresh" className="text-sm" /> Regenerate
                        </button>
                        <button onClick={handleSaveSuggestedToWishlist}
                          className="py-2 px-3 bg-surface-container hover:bg-surface-container-high text-on-surface-variant rounded-xl transition-colors">
                          <Icon name={wishlist.includes(suggestedRoute.id) ? "bookmark" : "bookmark_add"} className="text-sm" />
                        </button>
                        <button onClick={() => downloadGPXFile(suggestedRoute)}
                          className="py-2 px-3 bg-surface-container hover:bg-surface-container-high text-on-surface-variant rounded-xl transition-colors">
                          <Icon name="download" className="text-sm" />
                        </button>
                        <button onClick={clearSuggestion}
                          className="py-2 px-3 bg-surface-container hover:bg-surface-container-high text-on-surface-variant rounded-xl transition-colors">
                          <Icon name="close" className="text-sm" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <StatsBar stats={stats} />

            <RouteList
              filteredRoutes={filteredRoutes}
              selectedRoute={selectedRoute}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              showFilters={showFilters}
              filter={filter}
              setFilter={setFilter}
              setShowFilters={setShowFilters}
              getMonthOptions={getMonthOptions}
              onSelectRoute={setSelectedRoute}
              onDeleteRoute={handleDeleteRoute}
              onDownloadRoute={handleDownload}
              onEditRoute={setEditingRoute}
              fileInputRef={fileInputRef}
              onFileUpload={handleFileUpload}
              wishlist={wishlist}
              favorites={favorites}
              onToggleWishlist={handleSaveToWishlist}
              onToggleFavorite={handleToggleFavorite}
            />
          </div>

          {/* ── Map panel ── */}
          <div className="w-full md:w-1/2 md:shrink-0 order-1 md:order-none relative">
            {/* Floating search overlay — below header, over map */}
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

            <div className="h-52 sm:h-64 md:h-full p-4 md:pr-6 md:pt-6 md:pb-4">
              <MapSection
                routes={filteredRoutes}
                selectedRoute={selectedRoute}
                suggestedRoute={suggestedRoute}
                showHeatmap={showHeatmap}
                onToggleHeatmap={() => setShowHeatmap(!showHeatmap)}
                isLoading={isUploading}
                selectedStartPoint={selectedStartPoint}
                isSelectingStartPoint={isSelectingStartPoint}
                onMapClick={handleMapClick}
              />

            </div>

            {/* Mobile map controls: type legend (left) + heatmap toggle (right) — below map, above routes */}
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
              </div>
              <button
                onClick={() => setShowHeatmap(!showHeatmap)}
                className={`px-2 py-1 rounded-lg text-[10px] font-bold transition-colors ${
                  showHeatmap
                    ? "bg-primary text-on-primary"
                    : "bg-surface-container text-on-surface-variant hover:bg-surface-container-high"
                }`}
              >
                <Icon name="layers" className="text-[10px] inline mr-0.5" />
                {showHeatmap ? "Hide routes" : "Show routes"}
              </button>
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
          route={pendingUpload}
          onAccept={acceptUpload}
          onCancel={cancelUpload}
        />
      )}
    </div>
  );
}
