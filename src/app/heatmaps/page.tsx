"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth, logout } from "@/lib/auth";
import { useGPXRoutes, useUnifiedRoutes, useUserProfile } from "@/lib/hooks";
import { routeCountryNames, routeHasCountry } from "@/lib/countries";
import { Icon, LoginScreen, UploadModal } from "@/components/ui";
import { termsAcknowledgement } from "@/lib/privacy";
import { Sidebar, MobileDrawer } from "@/components/Sidebar";
import { MapSection } from "@/components/MapSection";
import type { PersonalHeatmapMode } from "@/components/Map";
import { buildVisitGrid, frequencyStops, summariseGrid } from "@/engine/heatmap";
import type { GPXRoute } from "../types";

type RouteTypeFilter = "all" | "road" | "trail" | "mixed";
type HeatmapMode = PersonalHeatmapMode;

/**
 * Three views, each answering a question a runner actually asks.
 *
 * Four became three. Heart rate went because the data is deliberately not
 * there — the ingestion spine downloads every activity with `hr=false`, since
 * heart rate is Art. 9 special-category data we chose never to hold — so the
 * mode could only ever have worked for a few legacy manual uploads, and an
 * option that is permanently greyed out is a promise the app keeps breaking.
 * Elevation went because the basemap already draws terrain, and a second,
 * worse rendering of the same fact is noise.
 *
 * Recency replaced them, and earns its place: every run carries a date, so
 * the view can always be filled, and "what have I not been down in a year"
 * is the question that turns a heatmap into a plan.
 */
const HEATMAP_OPTIONS: Array<{
  id: HeatmapMode;
  label: string;
  icon: string;
  detail: string;
}> = [
  { id: "frequency", label: "How often", icon: "whatshot", detail: "Your ruts, and the ground you have touched once" },
  { id: "recency", label: "How long ago", icon: "history", detail: "What you have not run in months" },
  { id: "pace", label: "Pace", icon: "speed", detail: "Where you run fast, and where you do not" },
];

export default function PersonalHeatmapsPage() {
  const { user, loading: authLoading } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authSuccess, setAuthSuccess] = useState("");
  const [isRegistering, setIsRegistering] = useState(false);
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [username, setUsername] = useState("");

  const [showDrawer, setShowDrawer] = useState(false);
  const [pendingUploads, setPendingUploads] = useState<GPXRoute[]>([]);
  const pendingUpload = pendingUploads[0] ?? null;
  const [routeType, setRouteType] = useState<RouteTypeFilter>("all");
  const [routeYear, setRouteYear] = useState("");
  const [routeMonth, setRouteMonth] = useState("");
  const [routeCountry, setRouteCountry] = useState("");
  const [activeHeatmap, setActiveHeatmap] = useState<HeatmapMode>("frequency");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [heatmapPanelCollapsed, setHeatmapPanelCollapsed] = useState(false);

  // Storage (uploads write here) versus display (synced runs merged in, dupes
  // collapsed). A heatmap built from the raw collection would burn a manually
  // uploaded run and its synced twin into the same pixels twice.
  const { routes, saveRoutes, uploadFiles, loading: isUploading } = useGPXRoutes(user?.uid ?? null);
  const { routes: unifiedRoutes } = useUnifiedRoutes(user?.uid ?? null, routes);
  const { profile, saveProfile, loading } = useUserProfile(user?.uid ?? null);

  const filteredRoutes = useMemo(() => {
    return unifiedRoutes.filter((route) => {
      if (routeType !== "all" && route.type !== routeType) return false;
      if (routeYear && !route.date.startsWith(routeYear)) return false;
      if (routeMonth && route.date.substring(5, 7) !== routeMonth) return false;
      if (routeCountry && !routeHasCountry(route, routeCountry)) return false;
      return true;
    });
  }, [unifiedRoutes, routeType, routeYear, routeMonth, routeCountry]);

  const countryOptions = useMemo(() => (
    Array.from(new Set(unifiedRoutes.flatMap((route) => routeCountryNames(route)))).sort((a, b) => a.localeCompare(b))
  ), [unifiedRoutes]);

  const yearOptions = useMemo(() => (
    Array.from(new Set(unifiedRoutes.map((route) => route.date.substring(0, 4)).filter(Boolean))).sort().reverse()
  ), [unifiedRoutes]);

  const monthOptions = useMemo(() => (
    Array.from(new Set(unifiedRoutes.map((route) => route.date.substring(5, 7)).filter(Boolean))).sort((a, b) => Number(a) - Number(b))
  ), [unifiedRoutes]);

  const stats = useMemo(() => {
    if (!filteredRoutes.length) return null;
    const totalDistance = filteredRoutes.reduce((sum, route) => sum + (route.distance || 0), 0) / 1000;
    const totalElevation = filteredRoutes.reduce((sum, route) => sum + (route.elevationGain || 0), 0);
    return {
      totalRuns: filteredRoutes.length,
      totalDistance: Math.round(totalDistance * 10) / 10,
      totalElevation: Math.round(totalElevation),
    };
  }, [filteredRoutes]);


  /**
   * The ground, counted once.
   *
   * Every view on this page reads from this one grid, which is what lets the
   * legend print real counts: the number beside a colour is the number the map
   * was drawn from, not a second calculation that happens to agree.
   */
  const visitGrid = useMemo(
    () => buildVisitGrid(filteredRoutes.map((route) => ({ coordinates: route.coordinates, date: route.date }))),
    [filteredRoutes],
  );

  const heatmapStops = useMemo(() => frequencyStops(visitGrid), [visitGrid]);
  const groundSummary = useMemo(() => summariseGrid(visitGrid), [visitGrid]);

  /**
   * The pace scale, trimmed at the 5th and 95th percentile.
   *
   * A single GPS glitch at a tunnel mouth produces a 90 km/h sample, and a
   * scale stretched to reach it leaves every real pace crushed into the first
   * few percent of the ramp — the same flattening that made the old frequency
   * view useless, arriving by a different route.
   */
  const paceRange = useMemo(() => {
    const speeds: number[] = [];
    for (const route of filteredRoutes) {
      for (const sample of route.samples ?? []) {
        if (typeof sample.paceMinPerKm === "number" && sample.paceMinPerKm > 0) speeds.push(1 / sample.paceMinPerKm);
      }
    }
    if (speeds.length < 2) return null;

    speeds.sort((a, b) => a - b);
    const min = speeds[Math.floor(speeds.length * 0.05)];
    const max = speeds[Math.floor(speeds.length * 0.95)];
    return max > min ? { min, max } : null;
  }, [filteredRoutes]);

  const availableHeatmaps = useMemo(() => ({
    frequency: visitGrid.cells.size > 0,
    recency: filteredRoutes.some((route) => Boolean(route.date)),
    pace: paceRange !== null,
  }), [visitGrid, filteredRoutes, paceRange]);

  useEffect(() => {
    if (!availableHeatmaps[activeHeatmap]) setActiveHeatmap("frequency");
  }, [activeHeatmap, availableHeatmaps]);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    setAuthSuccess("");
    if (showForgotPassword) {
      const { resetPassword: rp } = await import("@/lib/auth");
      try {
        await rp(email);
        setAuthSuccess("Check your email");
        setShowForgotPassword(false);
      } catch (err: any) {
        setAuthError(err.message || "Failed");
      }
      return;
    }
    try {
      const { login: lg, register: reg } = await import("@/lib/auth");
      if (isRegistering) {
        if (!username.trim() || username.trim().length < 3) {
          setAuthError("Please choose a username (at least 3 characters).");
          return;
        }
        await reg(email, password);
        await saveProfile({ username: username.trim(), displayName: username.trim(), ...termsAcknowledgement() });
        setUsername("");
      } else {
        await lg(email, password);
      }
      setEmail("");
      setPassword("");
    } catch (err: any) {
      setAuthError(err.message || "Auth failed");
    }
  };

  const handleLogout = async () => {
    await logout();
    saveRoutes([]);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const newRoutes = await uploadFiles(files, routes);
    if (newRoutes.length > 0) setPendingUploads(newRoutes);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleRouteUpload = async (gpxFiles: File[], tcxFiles: File[]) => {
    if (!gpxFiles.length) return;
    if (tcxFiles.length > 0) {
      console.info("[route upload] TCX files selected for future metrics import", tcxFiles.map((file) => file.name));
    }
    const newRoutes = await uploadFiles(gpxFiles, routes, tcxFiles);
    if (newRoutes.length > 0) setPendingUploads(newRoutes);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const acceptUpload = async (name: string, type: string) => {
    if (!pendingUpload) return;
    const named: GPXRoute = { ...pendingUpload, name, type: type as "road" | "trail" | "mixed" };
    saveRoutes([...routes, named]);
    setPendingUploads((pending) => pending.slice(1));
    if (named.id && user?.uid) {
      const { doc, updateDoc } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      if (db) updateDoc(doc(db, "routes", named.id), { name, type }).catch(console.error);
    }
  };

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

      <main className="flex-1 flex flex-col overflow-hidden">
        <header className="md:hidden h-14 bg-surface-container-lowest border-b border-outline-variant/10 flex items-center justify-between px-4 shrink-0 z-20">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-primary-container flex items-center justify-center">
              <Icon name="whatshot" filled className="text-on-primary-container text-sm" />
            </div>
            <span className="text-sm font-extrabold text-primary font-headline">Personal Heatmaps</span>
          </div>
          <button onClick={() => setShowDrawer(true)} className="p-2 -mr-2 rounded-xl hover:bg-surface-container transition-colors">
            <Icon name="menu" className="text-on-surface-variant text-xl" />
          </button>
        </header>

        <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
          <div
            className={`flex-1 overflow-y-auto px-4 pt-5 pb-4 md:pt-4 space-y-5 custom-scrollbar order-2 md:order-none transition-all duration-300 ease-out ${heatmapPanelCollapsed ? "md:flex-none md:w-0 md:p-0 md:opacity-0 md:pointer-events-none" : "md:p-6 md:opacity-100"}`}
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-primary-container flex items-center justify-center shrink-0">
                <Icon name="whatshot" className="text-primary text-xl" />
              </div>
              <div>
                <h2 className="text-xl font-extrabold text-on-surface">Personal Heatmaps</h2>
                <p className="text-xs text-on-surface-variant">Compare route layers</p>
              </div>
            </div>

            {/* The sentence a distance total can never give.
                1,458 km of running over 180 km of distinct ground means every
                metre was covered eight times on average — which is the fact
                the picture below is about to show him, said in words first. */}
            {groundSummary.uniqueGroundMeters > 0 && (
              <div className="bg-surface-container rounded-2xl px-4 py-3 space-y-1">
                <p className="text-sm text-on-surface">
                  <span className="font-extrabold text-primary">
                    {Math.round(groundSummary.uniqueGroundMeters / 100) / 10} km
                  </span>{" "}
                  of distinct ground
                  {stats ? <span className="text-on-surface-variant"> from {stats.totalDistance} km run</span> : null}.
                </p>
                <p className="text-[11px] text-on-surface-variant">
                  {Math.round(groundSummary.onceOnlyRatio * 100)}% of it you have been down exactly once
                  {groundSummary.maxVisits > 1 ? ` · your most-run ground, ${groundSummary.maxVisits} times` : ""}.
                </p>
              </div>
            )}

            {stats && (
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: "Runs", value: stats.totalRuns, icon: "directions_run" },
                  { label: "Distance", value: String(stats.totalDistance) + " km", icon: "route" },
                  { label: "Elevation", value: String(stats.totalElevation) + " m", icon: "terrain" },
                ].map(({ label, value, icon }) => (
                  <div key={label} className="bg-surface-container rounded-xl px-3 py-2.5 text-center">
                    <div className="flex justify-center mb-1">
                      <Icon name={icon} className="text-on-surface-variant text-sm" />
                    </div>
                    <p className="text-xs font-bold text-on-surface">{value}</p>
                    <p className="text-[9px] text-on-surface-variant uppercase tracking-wider">{label}</p>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center gap-1.5 p-1.5 bg-surface-container rounded-2xl border border-outline-variant/40">
              {(["all", "road", "trail", "mixed"] as const).map((type) => (
                <button
                  key={type}
                  onClick={() => setRouteType(type)}
                  className={
                    "flex-1 py-1.5 rounded-xl text-xs font-bold capitalize transition-colors " +
                    (routeType === type
                      ? "bg-primary-container text-on-primary-container"
                      : "text-on-surface-variant hover:bg-surface-container-high")
                  }
                >
                  {type === "all" ? "All" : type}
                </button>
              ))}
            </div>

            <div className="bg-surface-container-lowest border border-outline-variant/30 rounded-2xl p-3 flex flex-wrap items-center gap-2">
              <select
                value={routeYear}
                onChange={(e) => setRouteYear(e.target.value)}
                className="px-3 py-1.5 bg-surface-container border border-outline-variant rounded-xl text-xs text-on-surface focus:outline-none"
              >
                <option value="">All years</option>
                {yearOptions.map((year) => <option key={year} value={year}>{year}</option>)}
              </select>
              <select
                value={routeMonth}
                onChange={(e) => setRouteMonth(e.target.value)}
                className="px-3 py-1.5 bg-surface-container border border-outline-variant rounded-xl text-xs text-on-surface focus:outline-none"
              >
                <option value="">All months</option>
                {monthOptions.map((month) => (
                  <option key={month} value={month}>{new Date(2000, Number(month) - 1, 1).toLocaleDateString("en-GB", { month: "short" })}</option>
                ))}
              </select>
              {countryOptions.length > 1 && (
                <select
                  value={routeCountry}
                  onChange={(e) => setRouteCountry(e.target.value)}
                  className="px-3 py-1.5 bg-surface-container border border-outline-variant rounded-xl text-xs text-on-surface focus:outline-none"
                >
                  <option value="">All countries</option>
                  {countryOptions.map((country) => <option key={country} value={country}>{country}</option>)}
                </select>
              )}
              {(routeYear || routeMonth || routeCountry) && (
                <button
                  onClick={() => { setRouteYear(""); setRouteMonth(""); setRouteCountry(""); }}
                  className="text-xs text-error font-medium hover:underline"
                >
                  Clear filters
                </button>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-extrabold text-primary font-headline">Heatmaps</h3>
                <span className="text-xs font-medium text-on-surface-variant">{filteredRoutes.length} routes</span>
              </div>
              <div className="space-y-2">
                {HEATMAP_OPTIONS.map((option) => {
                  const active = activeHeatmap === option.id;
                  const enabled = availableHeatmaps[option.id];
                  return (
                    <button
                      key={option.id}
                      disabled={!enabled}
                      onClick={() => setActiveHeatmap(option.id)}
                      className={
                        "w-full px-4 py-3 rounded-2xl border text-left transition-colors " +
                        (active
                          ? "bg-primary-container/40 border-primary-container text-on-surface"
                          : "bg-surface-container border-outline-variant/30 text-on-surface hover:bg-surface-container-high") +
                        (!enabled ? " opacity-55 cursor-not-allowed" : "")
                      }
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={
                            "w-9 h-9 rounded-xl flex items-center justify-center " +
                            (active ? "bg-primary text-on-primary" : "bg-surface-container-high text-on-surface-variant")
                          }
                        >
                          <Icon name={option.icon} className="text-lg" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-bold">{option.label}</span>
                            {!enabled && (
                              <span className="text-[9px] font-extrabold uppercase tracking-wider text-on-surface-variant">Soon</span>
                            )}
                          </div>
                          <p className="text-xs text-on-surface-variant">{option.detail}</p>
                        </div>
                        {active && <Icon name="check_circle" filled className="text-primary text-base" />}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className={`w-full order-1 md:order-none relative transition-all duration-300 ease-out ${heatmapPanelCollapsed ? "md:flex-1" : "md:w-1/2 md:shrink-0"}`}>
            {heatmapPanelCollapsed ? (
              <button
                type="button"
                onClick={() => setHeatmapPanelCollapsed(false)}
                className={`fixed top-20 ${sidebarCollapsed ? "left-16" : "left-60"} z-50 hidden h-10 w-8 items-center justify-center rounded-full bg-surface-container-lowest text-primary shadow-card ring-1 ring-outline-variant/25 hover:bg-surface-container transition-colors md:flex`}
                title="Show heatmap controls"
                aria-label="Show heatmap controls"
              >
                <Icon name="chevron_right" className="text-lg" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setHeatmapPanelCollapsed(true)}
                className="absolute top-6 left-0 z-30 hidden h-10 w-8 -translate-x-1/2 items-center justify-center rounded-full bg-surface-container-lowest text-primary shadow-card ring-1 ring-outline-variant/25 hover:bg-surface-container transition-colors md:flex"
                title="Hide heatmap controls"
                aria-label="Hide heatmap controls"
              >
                <Icon name="chevron_left" className="text-lg" />
              </button>
            )}
            <div className="h-52 sm:h-64 md:h-full p-4 md:pr-6 md:pt-6 md:pb-4">
              <MapSection
                routes={filteredRoutes}
                selectedRoute={null}
                suggestedRoute={null}
                showHeatmap={false}
                fitAllRoutes={Boolean(routeCountry)}
                showPersonalHeatmap={availableHeatmaps[activeHeatmap]}
                personalHeatmapMode={activeHeatmap}
                heatmapGrid={visitGrid}
                heatmapStops={heatmapStops}
                heatmapPaceRange={paceRange}
                onToggleHeatmap={() => {}}
                onTogglePersonalHeatmap={() => {}}
                isLoading={isUploading}
                selectedStartPoint={null}
                isSelectingStartPoint={false}
                onMapClick={() => {}}
                showMapControls={false}
              />
            </div>
          </div>
        </div>

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

      {pendingUpload && (
        <UploadModal
          key={pendingUpload.id}
          route={pendingUpload}
          onAccept={acceptUpload}
          onCancel={() => setPendingUploads((pending) => pending.slice(1))}
        />
      )}
    </div>
  );
}
