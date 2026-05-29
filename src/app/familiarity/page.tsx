"use client";

import { useMemo, useRef, useState } from "react";
import { useAuth, logout } from "@/lib/auth";
import { calculateRouteFamiliarity, type RouteFamiliarityResult } from "@/lib/routeFamiliarity";
import { parseGPXFile } from "@/lib/utils";
import { useGPXRoutes, useUserProfile } from "@/lib/hooks";
import { Icon, LoginScreen } from "@/components/ui";
import { Sidebar, MobileDrawer } from "@/components/Sidebar";
import { MapSection } from "@/components/MapSection";
import type { GPXRoute } from "../types";

function resultTone(label: RouteFamiliarityResult["label"]) {
  if (label === "familiar") {
    return {
      icon: "check_circle",
      badge: "bg-secondary text-on-secondary",
      ring: "stroke-secondary",
      text: "text-secondary",
    };
  }
  if (label === "unfamiliar") {
    return {
      icon: "explore",
      badge: "bg-tertiary text-on-tertiary",
      ring: "stroke-tertiary",
      text: "text-tertiary",
    };
  }
  return {
    icon: "route",
    badge: "bg-primary text-on-primary",
    ring: "stroke-primary",
    text: "text-primary",
  };
}

export default function FamiliarityPage() {
  const { user, loading: authLoading } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const compareInputRef = useRef<HTMLInputElement>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authSuccess, setAuthSuccess] = useState("");
  const [isRegistering, setIsRegistering] = useState(false);
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [username, setUsername] = useState("");

  const { routes, uploadFiles, loading: routesLoading } = useGPXRoutes(user?.uid ?? null);
  const { profile, loading: profileLoading, saveProfile } = useUserProfile(user?.uid ?? null);
  const [showDrawer, setShowDrawer] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(true);
  const [uploadedRoute, setUploadedRoute] = useState<GPXRoute | null>(null);
  const [result, setResult] = useState<RouteFamiliarityResult | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [isComparing, setIsComparing] = useState(false);

  const stats = useMemo(() => {
    const totalDistance = routes.reduce((sum, route) => sum + (route.distance || 0), 0) / 1000;
    return {
      count: routes.length,
      distance: Math.round(totalDistance * 10) / 10,
    };
  }, [routes]);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    setAuthSuccess("");
    if (showForgotPassword) {
      const { resetPassword } = await import("@/lib/auth");
      try {
        await resetPassword(email);
        setAuthSuccess("✓ Check your email");
        setShowForgotPassword(false);
      } catch (err: any) {
        setAuthError(err.message || "Failed");
      }
      return;
    }
    try {
      const { login, register } = await import("@/lib/auth");
      if (isRegistering) {
        await register(email, password);
        await saveProfile({ username: username.trim(), displayName: username.trim() });
      } else {
        await login(email, password);
      }
    } catch (err: any) {
      setAuthError(err.message || "Authentication failed");
    }
  };

  const handleLogout = async () => {
    await logout();
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    await uploadFiles(files, routes);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleRouteUpload = async (gpxFiles: File[], tcxFiles: File[]) => {
    if (!gpxFiles.length) return;
    await uploadFiles(gpxFiles, routes, tcxFiles);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleCompareUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setCompareError(null);
    setIsComparing(true);
    try {
      const text = await file.text();
      const parsed = parseGPXFile(text, file.name.replace(/\.gpx$/i, ""));
      if (parsed.coordinates.length < 2) {
        throw new Error("That GPX file does not contain enough track points to compare.");
      }

      const candidate: GPXRoute = {
        id: `compare-${Date.now()}`,
        name: parsed.name,
        date: parsed.date,
        coordinates: parsed.coordinates,
        distance: parsed.distance,
        elevationGain: parsed.elevationGain,
        samples: parsed.samples,
        color: "rgb(197 45 255)",
        type: "mixed",
        userId: user?.uid,
      };

      setUploadedRoute(candidate);
      setResult(calculateRouteFamiliarity(candidate, routes));
    } catch (error) {
      setUploadedRoute(null);
      setResult(null);
      setCompareError(error instanceof Error ? error.message : "Could not read that GPX file.");
    } finally {
      setIsComparing(false);
      if (compareInputRef.current) compareInputRef.current.value = "";
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <LoginScreen
        email={email}
        setEmail={setEmail}
        password={password}
        setPassword={setPassword}
        authError={authError}
        authSuccess={authSuccess}
        isRegistering={isRegistering}
        setIsRegistering={setIsRegistering}
        showForgotPassword={showForgotPassword}
        setShowForgotPassword={setShowForgotPassword}
        username={username}
        setUsername={setUsername}
        handleAuth={handleAuth}
        setAuthError={setAuthError}
      />
    );
  }

  const tone = result ? resultTone(result.label) : null;
  const circumference = 2 * Math.PI * 52;
  const offset = result ? circumference * (1 - result.percent / 100) : circumference;

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
        <Sidebar
          user={user}
          profile={profile}
          profileLoading={profileLoading}
          onLogout={handleLogout}
          fileInputRef={fileInputRef}
          onFileUpload={handleFileUpload}
          onRouteUpload={handleRouteUpload}
        />

        <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
          <div className="flex-1 overflow-y-auto px-4 pt-5 pb-4 md:p-6 md:pt-4 space-y-5 custom-scrollbar">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-primary-container flex items-center justify-center shrink-0">
                <Icon name="compare_arrows" filled className="text-on-primary-container text-xl" />
              </div>
              <div>
                <h2 className="text-xl font-extrabold text-on-surface">Route Familiarity</h2>
                <p className="text-xs text-on-surface-variant">Compare a new GPX route against your route history</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="bg-surface-container rounded-xl px-3 py-3">
                <p className="text-lg font-extrabold text-on-surface">{stats.count}</p>
                <p className="text-[10px] text-on-surface-variant uppercase tracking-wider">Routes compared</p>
              </div>
              <div className="bg-surface-container rounded-xl px-3 py-3">
                <p className="text-lg font-extrabold text-on-surface">{stats.distance} km</p>
                <p className="text-[10px] text-on-surface-variant uppercase tracking-wider">Route history</p>
              </div>
            </div>

            <div className="bg-surface-container border border-outline-variant/20 rounded-2xl p-4 space-y-4">
              <label className="block rounded-2xl border border-outline-variant/50 bg-surface-container-lowest p-4 cursor-pointer hover:bg-surface-container-high transition-colors">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-primary-container flex items-center justify-center">
                    <Icon name="upload_file" className="text-primary text-lg" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-on-surface">GPX route to compare</p>
                    <p className="text-xs text-on-surface-variant truncate">
                      {uploadedRoute ? uploadedRoute.name : "Upload without saving it to your routes"}
                    </p>
                  </div>
                </div>
                <input
                  ref={compareInputRef}
                  type="file"
                  accept=".gpx,application/gpx+xml"
                  onChange={handleCompareUpload}
                  className="hidden"
                />
              </label>

              {routesLoading && (
                <div className="flex items-center gap-2 rounded-xl bg-surface-container-lowest px-3 py-2 text-xs text-on-surface-variant">
                  <Icon name="progress_activity" className="text-primary text-sm animate-spin" />
                  Loading your route history...
                </div>
              )}

              {isComparing && (
                <div className="flex items-center gap-2 rounded-xl bg-surface-container-lowest px-3 py-2 text-xs text-on-surface-variant">
                  <Icon name="progress_activity" className="text-primary text-sm animate-spin" />
                  Comparing route segments...
                </div>
              )}

              {compareError && (
                <div className="rounded-xl bg-error-container/40 border border-error/20 px-3 py-2 text-xs text-error">
                  {compareError}
                </div>
              )}
            </div>

            {result && tone && uploadedRoute && (
              <div className="bg-surface-container border border-outline-variant/20 rounded-2xl p-5 animate-fade-in">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider ${tone.badge}`}>
                        <Icon name={tone.icon} filled className="text-xs" />
                        {result.label}
                      </span>
                    </div>
                    <h3 className="text-base font-extrabold text-on-surface truncate">{uploadedRoute.name}</h3>
                    <p className="text-xs text-on-surface-variant mt-1">
                      {(uploadedRoute.distance / 1000).toFixed(1)} km route · {(result.matchedDistanceMeters / 1000).toFixed(1)} km matched
                    </p>
                  </div>

                  <div className="relative h-32 w-32 shrink-0">
                    <svg className="-rotate-90 h-32 w-32" viewBox="0 0 120 120" aria-hidden="true">
                      <circle cx="60" cy="60" r="52" fill="none" stroke="currentColor" className="text-surface-container-high" strokeWidth="12" />
                      <circle
                        cx="60"
                        cy="60"
                        r="52"
                        fill="none"
                        stroke="currentColor"
                        className={tone.ring}
                        strokeWidth="12"
                        strokeLinecap="round"
                        strokeDasharray={circumference}
                        strokeDashoffset={offset}
                      />
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <span className={`text-3xl font-extrabold ${tone.text}`}>{result.percent}%</span>
                      <span className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">familiar</span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="w-full md:w-1/2 md:shrink-0 order-1 md:order-none relative">
            <div className="h-52 sm:h-64 md:h-full p-4 md:pr-6 md:pt-6 md:pb-4">
              <MapSection
                routes={uploadedRoute ? [uploadedRoute] : routes}
                selectedRoute={uploadedRoute}
                suggestedRoute={null}
                showHeatmap={showHeatmap}
                fitAllRoutes
                showPersonalHeatmap={false}
                onToggleHeatmap={() => setShowHeatmap(!showHeatmap)}
                onTogglePersonalHeatmap={() => {}}
                isLoading={routesLoading || isComparing}
                selectedStartPoint={null}
                isSelectingStartPoint={false}
                onMapClick={() => {}}
                showPersonalHeatmapControl={false}
              />
            </div>
          </div>
        </div>
      </div>

      <MobileDrawer
        isOpen={showDrawer}
        onClose={() => setShowDrawer(false)}
        user={user}
        profile={profile}
        profileLoading={profileLoading}
        onLogout={handleLogout}
        fileInputRef={fileInputRef}
        onFileUpload={handleFileUpload}
        onRouteUpload={handleRouteUpload}
      />
    </div>
  );
}
