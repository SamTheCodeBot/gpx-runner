"use client";

import { useMemo, useRef, useState } from "react";
import { useAuth, logout } from "@/lib/auth";
import { useGPXRoutes, useUserProfile } from "@/lib/hooks";
import { Icon, LoginScreen, UploadModal } from "@/components/ui";
import { Sidebar } from "@/components/Sidebar";
import { BADGE_DEFINITIONS, BadgeContext } from "@/lib/badges";
import { routeCountryNames } from "@/lib/countries";
import type { GPXRoute } from "@/app/types";
import Link from "next/link";

const TIER_CONFIG = {
  bronze:   { label: "Bronze",   bg: "bg-[#fff1e6]", border: "border-[#d97706]/40", text: "text-[#9a4f00]", iconBg: "bg-[#f97316]", iconText: "text-white" },
  silver:   { label: "Silver",   bg: "bg-[#f1f5f9]", border: "border-[#64748b]/35", text: "text-[#475569]", iconBg: "bg-[#64748b]", iconText: "text-white" },
  gold:     { label: "Gold",     bg: "bg-[#fff7d6]", border: "border-[#ca8a04]/40", text: "text-[#854d0e]", iconBg: "bg-[#f59e0b]", iconText: "text-[#1f2937]" },
  platinum: { label: "Platinum", bg: "bg-[#eef2ff]", border: "border-[#6366f1]/35", text: "text-[#4338ca]", iconBg: "bg-[#6366f1]", iconText: "text-white" },
} as const;

function routeRepeatFingerprint(route: GPXRoute): string {
  if (route.coordinates.length < 2) return route.name.trim().toLowerCase();

  const roundCoord = ([lng, lat]: [number, number]) => `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const first = route.coordinates[0];
  const middle = route.coordinates[Math.floor(route.coordinates.length / 2)];
  const last = route.coordinates[route.coordinates.length - 1];
  const distanceBucketKm = Math.round((route.distance || 0) / 500) / 2;

  return [roundCoord(first), roundCoord(middle), roundCoord(last), distanceBucketKm].join("|");
}

function routeAreaKey(route: GPXRoute): string | null {
  if (route.coordinates.length === 0) return null;
  const lng = route.coordinates.reduce((sum, [lon]) => sum + lon, 0) / route.coordinates.length;
  const lat = route.coordinates.reduce((sum, [, routeLat]) => sum + routeLat, 0) / route.coordinates.length;
  return `${lat.toFixed(1)},${lng.toFixed(1)}`;
}

function routeStartHour(route: GPXRoute): number | null {
  const time = route.samples?.find((sample) => sample.time)?.time ?? route.date;
  const date = new Date(time);
  if (Number.isNaN(date.valueOf())) return null;
  return date.getHours();
}

function routeLooksRoundTrip(route: GPXRoute): boolean {
  if (route.isRoundTrip) return true;
  if (route.coordinates.length < 2) return false;
  const [startLon, startLat] = route.coordinates[0];
  const [endLon, endLat] = route.coordinates[route.coordinates.length - 1];
  const toRad = (value: number) => value * Math.PI / 180;
  const dLat = toRad(endLat - startLat);
  const dLon = toRad(endLon - startLon);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(startLat)) * Math.cos(toRad(endLat)) * Math.sin(dLon / 2) ** 2;
  const distanceM = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return distanceM <= Math.max(200, (route.distance || 0) * 0.03);
}

function computeBadgeContext(routes: GPXRoute[], _clubMemberships: string[] = []): BadgeContext {
  const totalRuns = routes.length;
  const totalDistanceKm = routes.reduce((s, r) => s + (r.distance || 0) / 1000, 0);
  const totalElevationM = routes.reduce((s, r) => s + (r.elevationGain || 0), 0);
  const longestRunKm = routes.reduce((best, r) => Math.max(best, (r.distance || 0) / 1000), 0);
  const routeTypes = new Set(routes.map((r) => r.type).filter(Boolean) as string[]);

  const totalCountries = new Set<string>();
  const routeCountries = new Map<string, Set<string>>();
  for (const r of routes) {
    const countries = new Set(routeCountryNames(r));
    countries.forEach((country) => totalCountries.add(country));
    routeCountries.set(r.id, countries);
  }

  // Streak
  const dateDays = Array.from(new Set(routes
    .map((r) => (r.date?.split("T")[0] ?? r.date) as string)
    .filter(Boolean)))
    .map((d) => new Date(`${d}T00:00:00`).valueOf())
    .sort((a, b) => b - a);

  let currentStreak = 0;
  let longestStreak = 0;
  let streak = dateDays.length > 0 ? 1 : 0;
  let latestStreak = dateDays.length > 0 ? 1 : 0;
  for (let i = 0; i < dateDays.length - 1; i++) {
    const diff = dateDays[i] - dateDays[i + 1];
    const ONE_DAY = 86_400_000;
    if (diff >= ONE_DAY - 60_000 && diff <= ONE_DAY + 60_000) {
      streak++;
    } else {
      if (i === streak - 1) latestStreak = streak;
      longestStreak = Math.max(longestStreak, streak);
      streak = 1;
    }
  }
  longestStreak = Math.max(longestStreak, streak);
  if (dateDays.length > 0 && latestStreak === 1 && streak === dateDays.length) latestStreak = streak;
  const now = Date.now();
  const ONE_DAY = 86_400_000;
  if (dateDays.length > 0 && now - dateDays[0] <= ONE_DAY + 60_000) {
    currentStreak = latestStreak;
  }

  // Repeat runs on same route
  const routeFingerprints = new Map<string, number>();
  for (const r of routes) {
    const fp = routeRepeatFingerprint(r);
    routeFingerprints.set(fp, (routeFingerprints.get(fp) ?? 0) + 1);
  }
  const maxRunsOnSingleRoute = Math.max(...routeFingerprints.values(), 1);
  const uniqueRouteFingerprints = routeFingerprints.size;
  const distinctAreas = new Set(routes.map(routeAreaKey).filter(Boolean)).size;

  const monthNumbers = new Set<number>();
  const monthsByYear = new Map<number, Set<number>>();
  const dateKeys = new Set<string>();
  for (const route of routes) {
    const datePart = route.date?.split("T")[0];
    if (!datePart) continue;
    const date = new Date(`${datePart}T00:00:00`);
    if (Number.isNaN(date.valueOf())) continue;
    dateKeys.add(datePart);
    monthNumbers.add(date.getMonth());
    const year = date.getFullYear();
    const months = monthsByYear.get(year) ?? new Set<number>();
    months.add(date.getMonth());
    monthsByYear.set(year, months);
  }

  const hasWeekendPair = Array.from(dateKeys).some((dateKey) => {
    const date = new Date(`${dateKey}T00:00:00`);
    if (date.getDay() !== 6) return false;
    const sunday = new Date(date);
    sunday.setDate(date.getDate() + 1);
    return dateKeys.has(sunday.toISOString().slice(0, 10));
  });

  const hasFullCalendarYear = Array.from(monthsByYear.values()).some((months) => months.size >= 12);
  const hasWinterSeason = monthNumbers.has(11) && monthNumbers.has(0) && monthNumbers.has(1);
  const hasSummerSeason = monthNumbers.has(5) && monthNumbers.has(6) && monthNumbers.has(7);
  const earlyRuns = routes.filter((route) => {
    const hour = routeStartHour(route);
    return hour !== null && hour < 7;
  }).length;
  const nightRuns = routes.filter((route) => {
    const hour = routeStartHour(route);
    return hour !== null && hour >= 21;
  }).length;

  return {
    totalRuns,
    totalDistanceKm,
    totalElevationM,
    countriesRun: new Set<string>(),
    routeCountries,
    clubMemberships: [],
    hasRunClub: false,
    routeTypes,
    maxRunsOnSingleRoute,
    longestRunKm,
    totalCountries,
    currentStreak,
    longestStreak,
    routesWithTcx: routes.filter((route) => route.hasTcx).length,
    roundTripRuns: routes.filter(routeLooksRoundTrip).length,
    uniqueRouteFingerprints,
    distinctAreas,
    hasWeekendPair,
    hasFullCalendarYear,
    hasWinterSeason,
    hasSummerSeason,
    earlyRuns,
    nightRuns,
  };
}

function BadgeCard({ badge, earned, progress }: { badge: (typeof BADGE_DEFINITIONS)[0]; earned: boolean; progress: string }) {
  const cfg = TIER_CONFIG[badge.tier];
  return (
    <div className={`relative flex flex-col items-center p-4 rounded-2xl transition-all ${earned ? cfg.bg : "bg-surface-container"} ${earned ? `border ${cfg.border}` : "border border-outline-variant/20"}`}>
      <div className={`absolute top-3 right-3 text-[9px] font-extrabold uppercase tracking-widest ${earned ? cfg.text : "text-on-surface-variant"}`}>
        {cfg.label}
      </div>
      <div className={`w-12 h-12 rounded-2xl flex items-center justify-center mb-3 ${earned ? cfg.iconBg : "bg-surface-container-high border border-outline-variant/30"}`}>
        <span className={`material-symbols-outlined text-2xl ${earned ? cfg.iconText : "text-on-surface-variant/55"}`}>{badge.icon}</span>
      </div>
      <p className={`text-xs font-extrabold text-center mb-1 ${earned ? "text-on-surface" : "text-on-surface-variant/60"}`}>
        {badge.name}
      </p>
      <p className={`text-[10px] text-center leading-relaxed mb-3 ${earned ? "text-on-surface-variant" : "text-on-surface-variant/40"}`}>
        {badge.description}
      </p>
      {earned ? (
        <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-bold bg-surface-container-lowest/70 ${cfg.text}`}>
          <span className="material-symbols-outlined text-xs">check_circle</span>
          Earned
        </div>
      ) : (
        <div className="flex items-center gap-1 px-2 py-1 bg-surface-container-high rounded-full">
          <span className="text-[10px] font-medium text-on-surface-variant/50">{progress}</span>
        </div>
      )}
    </div>
  );
}

export default function BadgesPage() {
  const { user, loading: authLoading } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingUploads, setPendingUploads] = useState<GPXRoute[]>([]);
  const pendingUpload = pendingUploads[0] ?? null;

  const { routes, saveRoutes, uploadFiles } = useGPXRoutes(user?.uid ?? null);
  const { profile, loading: profileLoading } = useUserProfile(user?.uid ?? null);

  const ctx = useMemo(() => computeBadgeContext(routes, []), [routes]);

  const earnedIds = useMemo(() => {
    const earned: string[] = [];
    for (const b of BADGE_DEFINITIONS) {
      if (b.check(ctx)) earned.push(b.id);
    }
    return new Set(earned);
  }, [ctx]);

  const byTier = useMemo(() => {
    const tiers = ["bronze", "silver", "gold", "platinum"] as const;
    return tiers.map((tier) => ({
      tier,
      config: TIER_CONFIG[tier],
      badges: BADGE_DEFINITIONS.filter((b) => b.tier === tier),
    }));
  }, []);

  const totalEarned = earnedIds.size;
  const totalBadges = BADGE_DEFINITIONS.length;

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
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <LoginScreen
        email="" setEmail={() => {}}
        username="" setUsername={() => {}}
        password="" setPassword={() => {}}
        authError="" authSuccess=""
        isRegistering={false} setIsRegistering={() => {}}
        showForgotPassword={false} setShowForgotPassword={() => {}}
        handleAuth={() => {}} setAuthError={() => {}}
      />
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar
        user={user}
        profile={profile}
        profileLoading={profileLoading}
        onLogout={handleLogout}
        fileInputRef={fileInputRef}
        onFileUpload={handleFileUpload}
        onRouteUpload={handleRouteUpload}
      />

      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile header */}
        <header className="md:hidden h-14 bg-surface-container-lowest border-b border-outline-variant/10 flex items-center justify-between px-4 shrink-0 z-20">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-primary-container flex items-center justify-center">
              <Icon name="sprint" filled className="text-on-primary-container text-sm" />
            </div>
            <span className="text-sm font-extrabold text-primary font-headline">GPX running</span>
          </div>
          <Link href="/" className="p-2 -mr-2 rounded-xl hover:bg-surface-container transition-colors">
            <Icon name="arrow_back" className="text-on-surface-variant text-xl" />
          </Link>
        </header>

        <div className="flex-1 overflow-y-auto px-4 pt-6 pb-8 custom-scrollbar">
          {/* Header */}
          <div className="flex items-center gap-4 mb-6">
            <div className="w-12 h-12 rounded-2xl bg-primary-container flex items-center justify-center shrink-0">
              <Icon name="emoji_events" className="text-primary text-2xl" />
            </div>
            <div>
              <h1 className="text-2xl font-extrabold text-on-surface font-headline">Achievement Badges</h1>
              <p className="text-sm text-on-surface-variant">
                {totalEarned === 0 ? "Start running to earn badges!" : `${totalEarned} of ${totalBadges} badges earned`}
              </p>
            </div>
          </div>

          {/* Progress bar */}
          <div className="mb-8">
            <div className="h-3 bg-surface-container rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-primary to-secondary rounded-full transition-all duration-500"
                style={{ width: `${totalBadges > 0 ? (totalEarned / totalBadges) * 100 : 0}%` }}
              />
            </div>
            <p className="text-xs text-on-surface-variant mt-2 text-right">{totalEarned}/{totalBadges} badges</p>
          </div>

          {/* Tiers */}
          {byTier.map(({ tier, config, badges }) => {
            const earned = badges.filter((b) => earnedIds.has(b.id)).length;
            return (
              <div key={tier} className="mb-8">
                <div className="flex items-center gap-2 mb-4">
                  <span className={`text-sm font-extrabold ${config.text}`}>
                    {config.label}
                  </span>
                  <div className="flex-1 border-t border-outline-variant/20" />
                  <span className="text-xs text-on-surface-variant">{earned}/{badges.length}</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                  {badges.map((badge) => (
                    <BadgeCard
                      key={badge.id}
                      badge={badge}
                      earned={earnedIds.has(badge.id)}
                      progress={badge.progress ? badge.progress(ctx) : ""}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
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
