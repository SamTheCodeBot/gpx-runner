"use client";

import { useMemo, useRef, useState } from "react";
import { useAuth, logout } from "@/lib/auth";
import { useGPXRoutes, useUserProfile } from "@/lib/hooks";
import { Icon, LoginScreen, UploadModal } from "@/components/ui";
import { Sidebar, MobileDrawer } from "@/components/Sidebar";
import { MapSection } from "@/components/MapSection";
import type { GPXRoute } from "../types";

type RouteTypeFilter = "all" | "road" | "trail" | "mixed";
type HeatmapMode = "frequency" | "pace" | "heart-rate" | "elevation";

const HEATMAP_OPTIONS: Array<{
  id: HeatmapMode;
  label: string;
  icon: string;
  detail: string;
}> = [
  { id: "frequency", label: "Frequency", icon: "whatshot", detail: "Repeated paths" },
  { id: "pace", label: "Pace", icon: "speed", detail: "Fast sections are thicker" },
  { id: "heart-rate", label: "Heart rate", icon: "monitor_heart", detail: "Higher heart rate is thicker" },
  { id: "elevation", label: "Elevation", icon: "terrain", detail: "Higher elevation is thicker" },
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
  const [activeHeatmap, setActiveHeatmap] = useState<HeatmapMode>("frequency");

  const { routes, saveRoutes, uploadFiles, loading: isUploading } = useGPXRoutes(user?.uid ?? null);
  const { profile, saveProfile, loading } = useUserProfile(user?.uid ?? null);

  const filteredRoutes = useMemo(() => {
    if (routeType === "all") return routes;
    return routes.filter((route) => route.type === routeType);
  }, [routes, routeType]);

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

  const availableHeatmaps = useMemo(() => ({
    frequency: true,
    pace: filteredRoutes.some((route) => route.samples?.some((sample) => typeof sample.paceMinPerKm === "number")),
    "heart-rate": filteredRoutes.some((route) => route.samples?.some((sample) => typeof sample.heartRate === "number")),
    elevation: filteredRoutes.some((route) => route.samples?.some((sample) => typeof sample.elevation === "number")),
  }), [filteredRoutes]);

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
        await saveProfile({ username: username.trim(), displayName: username.trim() });
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
          <div className="flex-1 overflow-y-auto px-4 pt-5 pb-4 md:p-6 md:pt-4 space-y-5 custom-scrollbar order-2 md:order-none">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-primary-container flex items-center justify-center shrink-0">
                <Icon name="whatshot" className="text-primary text-xl" />
              </div>
              <div>
                <h2 className="text-xl font-extrabold text-on-surface">Personal Heatmaps</h2>
                <p className="text-xs text-on-surface-variant">Compare route layers</p>
              </div>
            </div>

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

          <div className="w-full md:w-1/2 md:shrink-0 order-1 md:order-none relative">
            <div className="h-52 sm:h-64 md:h-full p-4 md:pr-6 md:pt-6 md:pb-4">
              <MapSection
                routes={filteredRoutes}
                selectedRoute={null}
                suggestedRoute={null}
                showHeatmap={false}
                showPersonalHeatmap={availableHeatmaps[activeHeatmap]}
                personalHeatmapMode={activeHeatmap}
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
          route={pendingUpload}
          onAccept={acceptUpload}
          onCancel={() => setPendingUploads((pending) => pending.slice(1))}
        />
      )}
    </div>
  );
}
