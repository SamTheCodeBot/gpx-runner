"use client";

import { useState, useRef, useMemo } from "react";
import { useAuth, logout } from "@/lib/auth";
import { downloadGPXFile } from "@/lib/utils";
import { useGPXRoutes, useRouteSuggestions, useUserProfile, useWishlist } from "@/lib/hooks";
import { Icon, LoginScreen } from "@/components/ui";
import { Sidebar, MobileDrawer } from "@/components/Sidebar";
import { MapSection } from "@/components/MapSection";
import type { GPXRoute } from "../types";

export default function SuggestPage() {
  const { user, loading: authLoading } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authSuccess, setAuthSuccess] = useState("");
  const [isRegistering, setIsRegistering] = useState(false);
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [username, setUsername] = useState("");

  const { routes, uploadFiles, loading: isUploading } = useGPXRoutes(user?.uid ?? null);

  const [showDrawer, setShowDrawer] = useState(false);
  const [selectedStartPoint, setSelectedStartPoint] = useState<[number, number] | null>(null);
  const [isSelectingStartPoint, setIsSelectingStartPoint] = useState(false);
  const [suggestDistance, setSuggestDistance] = useState(5);
  const [avoidFamiliar, setAvoidFamiliar] = useState(true);
  const [selectedType, setSelectedType] = useState<"road" | "trail" | "mixed">("mixed");
  const [showHeatmap, setShowHeatmap] = useState(true);

  const { profile, loading, saveProfile } = useUserProfile(user?.uid ?? null);

  const stats = useMemo(() => {
    if (!routes.length) return null;
    const totalDistance = routes.reduce((s, r) => s + (r.distance || 0), 0) / 1000;
    const totalElevation = routes.reduce((s, r) => s + (r.elevationGain || 0), 0);
    return { totalRuns: routes.length, totalDistance: Math.round(totalDistance * 10) / 10, totalElevation: Math.round(totalElevation) };
  }, [routes]);

  const { suggestedRoute, isSuggesting, getSuggestion, clearSuggestion } =
    useRouteSuggestions(suggestDistance, avoidFamiliar);
  const { wishlist, toggleWishlist } = useWishlist(user?.uid ?? null);

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
        await reg(email, password);
        await saveProfile({ username: username.trim(), displayName: username.trim() });
      } else {
        await lg(email, password);
      }
    } catch (err: any) { setAuthError(err.message || "Authentication failed"); }
  };

  const handleLogout = async () => { await logout(); };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    await uploadFiles(files, routes);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleMapClick = (lat: number, lon: number) => {
    if (isSelectingStartPoint) { setSelectedStartPoint([lon, lat]); setIsSelectingStartPoint(false); }
  };

  const handleSaveSuggestedToWishlist = async () => { if (suggestedRoute) await toggleWishlist(suggestedRoute.id); };
  const handleGenerate = () => { getSuggestion(selectedStartPoint, routes); };

  if (authLoading) {
    return <div className="min-h-screen bg-background flex items-center justify-center"><div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>;
  }

  if (!user) {
    return <LoginScreen email={email} setEmail={setEmail} password={password} setPassword={setPassword}
      authError={authError} authSuccess={authSuccess} isRegistering={isRegistering} setIsRegistering={setIsRegistering}
      showForgotPassword={showForgotPassword} setShowForgotPassword={setShowForgotPassword}
      username={username} setUsername={setUsername} handleAuth={handleAuth} setAuthError={setAuthError} />;
  }

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      <header className="md:hidden flex items-center justify-between px-4 py-3 border-b border-outline-variant bg-primary text-on-primary">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-primary-container flex items-center justify-center">
            <Icon name="sprint" filled className="text-on-primary-container text-sm" />
          </div>
          <span className="font-headline font-extrabold text-base">GPX running</span>
        </div>
        <button onClick={() => setShowDrawer(true)} className="p-1.5 hover:bg-primary-container rounded-lg transition-colors">
          <Icon name="menu" className="text-xl" />
        </button>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <Sidebar user={user} profile={profile} profileLoading={loading} onLogout={handleLogout}
          fileInputRef={fileInputRef} onFileUpload={handleFileUpload} />

        <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
          {/* Left panel: controls + generated route */}
          <div className="flex-1 overflow-y-auto px-4 pt-5 pb-4 md:p-6 md:pt-4 space-y-5 custom-scrollbar">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-primary-container flex items-center justify-center shrink-0">
                <Icon name="explore" className="text-primary text-xl" />
              </div>
              <div>
                <h2 className="text-xl font-extrabold text-on-surface">Route Suggestions</h2>
                <p className="text-xs text-on-surface-variant">Generate a loop from your running history</p>
              </div>
            </div>

            {stats && (
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: "Runs", value: stats.totalRuns, icon: "directions_run" },
                  { label: "Distance", value: `${stats.totalDistance} km`, icon: "route" },
                  { label: "Elevation", value: `${stats.totalElevation} m`, icon: "terrain" },
                ].map(({ label, value, icon }) => (
                  <div key={label} className="bg-surface-container rounded-xl px-3 py-2.5 text-center">
                    <div className="flex justify-center mb-1">
                      <span className="material-symbols-outlined text-on-surface-variant text-sm">{icon}</span>
                    </div>
                    <p className="text-xs font-bold text-on-surface">{value}</p>
                    <p className="text-[9px] text-on-surface-variant uppercase tracking-wider">{label}</p>
                  </div>
                ))}
              </div>
            )}

            <div className="bg-surface-container border border-outline-variant/20 rounded-2xl overflow-hidden">
              <div className="px-4 pt-4 pb-4 space-y-4">
                {/* Distance */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-on-surface-variant">Distance</span>
                    <span className="text-xs font-bold text-primary">{suggestDistance} km</span>
                  </div>
                  <input type="range" min={1} max={30} step={0.5} value={suggestDistance}
                    onChange={e => setSuggestDistance(parseFloat(e.target.value))} className="w-full accent-primary" />
                </div>

                {/* Type */}
                <div>
                  <div className="mb-1.5">
                    <span className="text-xs font-medium text-on-surface-variant">Route Type</span>
                  </div>
                  <div className="flex gap-2">
                    {(["road", "trail", "mixed"] as const).map(t => (
                      <button key={t} onClick={() => setSelectedType(t)}
                        className={`flex-1 py-1.5 rounded-xl text-xs font-bold capitalize transition-colors ${
                          selectedType === t
                            ? t === "road" ? "bg-pink-100 text-pink-700" : t === "trail" ? "bg-cyan-100 text-cyan-700" : "bg-purple-100 text-purple-700"
                            : "bg-surface-container-high text-on-surface-variant hover:bg-surface-container-low"
                        }`}>{t}</button>
                    ))}
                  </div>
                </div>

                {/* Familiar / Novel */}
                <div className="flex items-center gap-3">
                  <span className="text-xs font-medium text-on-surface-variant w-16">Mode</span>
                  <button onClick={() => setAvoidFamiliar(false)}
                    className={`flex-1 py-1.5 rounded-xl text-xs font-bold transition-colors ${
                      !avoidFamiliar ? "bg-primary-container text-on-primary-container" : "bg-surface-container-high text-on-surface-variant"
                    }`}>🏠 Familiar</button>
                  <button onClick={() => setAvoidFamiliar(true)}
                    className={`flex-1 py-1.5 rounded-xl text-xs font-bold transition-colors ${
                      avoidFamiliar ? "bg-primary-container text-on-primary-container" : "bg-surface-container-high text-on-surface-variant"
                    }`}>🧭 Novel</button>
                </div>

                {/* Start point */}
                <div>
                  <div className="mb-1.5">
                    <span className="text-xs font-medium text-on-surface-variant">Start Point</span>
                  </div>
                  {selectedStartPoint ? (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 px-3 py-1.5 bg-surface-container-high rounded-xl text-xs text-on-surface font-mono">
                        {selectedStartPoint[1].toFixed(4)}, {selectedStartPoint[0].toFixed(4)}
                      </div>
                      <button onClick={() => { setSelectedStartPoint(null); setIsSelectingStartPoint(true); }}
                        className="px-3 py-1.5 bg-surface-container-high hover:bg-surface-container-low rounded-xl text-xs font-medium text-on-surface-variant transition-colors">Change</button>
                    </div>
                  ) : (
                    <button onClick={() => setIsSelectingStartPoint(true)}
                      className="w-full py-2 bg-primary-container text-on-primary-container rounded-xl text-xs font-bold hover:opacity-90 transition-opacity">📍 Pick on Map</button>
                  )}
                  {isSelectingStartPoint && (
                    <p className="mt-1.5 text-xs text-primary font-medium animate-pulse">↖ Tap anywhere on the map to set the start point</p>
                  )}
                </div>

                {/* Generate */}
                <button onClick={handleGenerate} disabled={isSuggesting}
                  className="w-full py-2.5 bg-primary text-on-primary rounded-xl text-sm font-bold hover:opacity-90 disabled:opacity-50 transition-opacity flex items-center justify-center gap-2">
                  {isSuggesting
                    ? <><Icon name="progress_activity" className="text-sm animate-spin" /> Generating&hellip;</>
                    : <><Icon name="sprint" className="text-sm" /> Generate Route</>}
                </button>
              </div>

              {/* Generated result */}
              {suggestedRoute && (
                <div className="mx-4 mb-4 bg-primary-container/10 border border-primary-container/30 rounded-2xl p-4 animate-fade-in">
                  <div className="flex items-center gap-2 mb-2">
                    <Icon name="check_circle" filled className="text-secondary text-base" />
                    <span className="text-[10px] font-extrabold uppercase tracking-wider text-secondary">Generated Route</span>
                    {suggestedRoute.type && (
                      <span className={`ml-auto text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
                        suggestedRoute.type === "road" ? "bg-pink-100 text-pink-700"
                          : suggestedRoute.type === "trail" ? "bg-cyan-100 text-cyan-700"
                          : "bg-purple-100 text-purple-700"
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
          </div>

          {/* Right panel: map */}
          <div className="w-full md:w-1/2 md:shrink-0 order-1 md:order-none relative">
            <div className="h-52 sm:h-64 md:h-full p-4 md:pr-6 md:pt-6 md:pb-4">
              <MapSection
                routes={routes}
                selectedRoute={suggestedRoute}
                suggestedRoute={suggestedRoute}
                showHeatmap={showHeatmap}
                showPersonalHeatmap={false}
                onToggleHeatmap={() => setShowHeatmap(!showHeatmap)}
                onTogglePersonalHeatmap={() => {}}
                isLoading={isUploading}
                selectedStartPoint={selectedStartPoint}
                isSelectingStartPoint={isSelectingStartPoint}
                onMapClick={handleMapClick}
              />
            </div>
            {/* Mobile map controls */}
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
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-colors ${showHeatmap ? "bg-secondary text-on-secondary" : "bg-surface-container-high text-on-surface-variant"}`}
              >
                <Icon name="layers" className="text-[10px] inline mr-0.5" />
                {showHeatmap ? "Hide" : "Show"}
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
      />
    </div>
  );
}
