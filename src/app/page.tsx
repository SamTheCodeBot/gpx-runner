"use client";

import { useState, useRef } from "react";
import { useAuth, logout } from "@/lib/auth";
import { downloadGPXFile } from "@/lib/utils";
import { useGPXRoutes, useRouteStats, useRouteFilter, useRouteSuggestions } from "@/lib/hooks";
import { Icon, EditModal, LoginScreen } from "@/components/ui";
import { Sidebar, MobileBottomNav } from "@/components/Sidebar";
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
  const [activeTab, setActiveTab]          = useState("routes");
  const [searchQuery, setSearchQuery]       = useState("");
  const [showFilters, setShowFilters]      = useState(false);
  const [filter, setFilter]                = useState<{ month?: string; type?: string }>({});
  const [selectedStartPoint, setSelectedStartPoint] = useState<[number, number] | null>(null);
  const [isSelectingStartPoint, setIsSelectingStartPoint] = useState(false);
  const [suggestDistance, setSuggestDistance] = useState(5);
  const [avoidFamiliar, setAvoidFamiliar]   = useState(true);

  // ── Derived ────────────────────────────────────────────────────────────────
  const filteredRoutes = useRouteFilter(routes, filter, searchQuery);
  const stats = useRouteStats(routes);
  const { suggestedRoute, isSuggesting, apiKeyMissing, getSuggestion, clearSuggestion } =
    useRouteSuggestions(suggestDistance, avoidFamiliar);

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
      isRegistering ? await reg(email, password) : await lg(email, password);
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
      saveRoutes([...routes, ...newRoutes]);
      setSelectedRoute(newRoutes[0]);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleDeleteRoute = (id: string) => {
    deleteRoute(id, routes);
    if (selectedRoute?.id === id) setSelectedRoute(null);
  };

  const handleUpdateRoute = (id: string, name: string, type: string) => {
    updateRoute(id, name, type, routes);
    if (selectedRoute && selectedRoute.id === id) setSelectedRoute({ ...selectedRoute, name, type: type as "road" | "trail" | undefined });
    setEditingRoute(null);
  };

  const handleDownload = (route: GPXRoute) => downloadGPXFile(route);

  const handleMapClick = (lat: number, lon: number) => {
    if (isSelectingStartPoint) {
      setSelectedStartPoint([lon, lat]);
      setIsSelectingStartPoint(false);
    }
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
        user={user} onLogout={handleLogout}
        fileInputRef={fileInputRef} onFileUpload={handleFileUpload}
      />

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="h-14 bg-surface-container-lowest border-b border-outline-variant/10 flex items-center justify-between px-4 md:px-8 shrink-0 z-20">
          <div className="flex items-center gap-3">
            <div className="md:hidden flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-primary-container flex items-center justify-center">
                <Icon name="sprint" filled className="text-on-primary-container text-sm" />
              </div>
              <span className="text-sm font-extrabold text-primary font-headline">GPX running</span>
            </div>
          </div>
          <div className="flex items-center gap-2" />
        </header>

        {/* Desktop: side-by-side | Mobile: tab-switched panels */}
        <div className="flex-1 flex flex-col md:flex-row overflow-hidden">

          {/* ── Routes panel ── */}
          <div className={
            "flex-1 overflow-y-auto p-4 md:p-6 space-y-5 custom-scrollbar " +
            (activeTab === "map" ? "hidden md:block" : "block")
          }>
            {suggestedRoute && (
              <div className="bg-primary-container/10 border border-primary-container/30 rounded-2xl p-4 animate-fade-in">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2 mb-0.5">
                      <Icon name="check_circle" filled className="text-secondary text-base" />
                      <span className="text-[10px] font-extrabold uppercase tracking-wider text-secondary">Generated Route</span>
                    </div>
                    <h4 className="text-base font-extrabold text-primary">{suggestedRoute.name}</h4>
                    <p className="text-xs text-on-surface-variant mt-0.5">
                      {(suggestedRoute.distance / 1000).toFixed(1)} km
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={handleGenerate} disabled={isSuggesting}
                      className="p-2 hover:bg-primary-container/20 rounded-xl text-xs font-bold text-primary transition-colors">
                      <Icon name="refresh" className="text-base" />
                    </button>
                    <button onClick={clearSuggestion}
                      className="p-2 hover:bg-primary-container/20 rounded-xl transition-colors">
                      <Icon name="close" className="text-on-surface-variant text-sm" />
                    </button>
                  </div>
                </div>
              </div>
            )}

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
            />
          </div>

          {/* ── Map panel ── */}
          <div className={
            "w-full md:w-1/2 md:shrink-0 " +
            (activeTab === "routes" ? "hidden md:block" : "block")
          }>
            <div className="h-52 md:h-full p-4 md:pr-6 md:pt-6 md:pb-4">
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
          </div>

        </div>

        {/* Mobile bottom nav */}
        <MobileBottomNav
          activeTab={activeTab}
          onTabChange={setActiveTab}
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
        />
      )}
    </div>
  );
}
