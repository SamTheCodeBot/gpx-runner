"use client";

import { useMemo } from "react";
import { useAuth } from "@/lib/auth";
import { useGPXRoutes, useUserProfile } from "@/lib/hooks";
import { Icon, LoginScreen } from "@/components/ui";
import { Sidebar } from "@/components/Sidebar";
import { BADGE_DEFINITIONS, BadgeContext } from "@/lib/badges";
import type { GPXRoute } from "@/app/types";
import Link from "next/link";

const TIER_CONFIG = {
  bronze:   { label: "Bronze",   color: "#cd7f32", bg: "bg-[#cd7f32]/10", border: "border-[#cd7f32]/30", text: "text-[#cd7f32]", icon: "⬤" },
  silver:   { label: "Silver",   color: "#c0c0c0", bg: "bg-[#c0c0c0]/10", border: "border-[#c0c0c0]/30", text: "text-[#c0c0c0]", icon: "◈" },
  gold:     { label: "Gold",     color: "#ffd700", bg: "bg-[#ffd700]/10", border: "border-[#ffd700]/30", text: "text-[#ffd700]", icon: "★" },
  platinum: { label: "Platinum", color: "#e5e4e2", bg: "bg-[#e5e4e2]/10", border: "border-[#e5e4e2]/30", text: "text-[#e5e4e2]", icon: "✦" },
} as const;

function computeBadgeContext(routes: GPXRoute[], _clubMemberships: string[] = []): BadgeContext {
  const totalRuns = routes.length;
  const totalDistanceKm = routes.reduce((s, r) => s + (r.distance || 0) / 1000, 0);
  const totalElevationM = routes.reduce((s, r) => s + (r.elevationGain || 0), 0);
  const longestRunKm = routes.reduce((best, r) => Math.max(best, (r.distance || 0) / 1000), 0);

  // Country detection: rough lat/lng buckets (~country-level)
  const countryBuckets = new Set<string>();
  for (const r of routes) {
    if (!r.coordinates.length) continue;
    const mid = r.coordinates[Math.floor(r.coordinates.length / 2)];
    const [lng, lat] = mid;
    countryBuckets.add(`${lat.toFixed(1)},${lng.toFixed(1)}`);
  }

  // Streak
  const dates = routes
    .map((r) => (r.date?.split("T")[0] ?? r.date) as string)
    .filter(Boolean)
    .map((d) => new Date(d).valueOf())
    .sort((a, b) => b - a);

  let currentStreak = 0;
  let longestStreak = 0;
  let streak = 1;
  for (let i = 0; i < dates.length - 1; i++) {
    const diff = dates[i] - dates[i + 1];
    const ONE_DAY = 86_400_000;
    if (diff >= ONE_DAY - 60_000 && diff <= ONE_DAY + 60_000) {
      streak++;
    } else {
      longestStreak = Math.max(longestStreak, streak);
      streak = 1;
    }
  }
  longestStreak = Math.max(longestStreak, streak);
  const now = Date.now();
  const ONE_DAY = 86_400_000;
  if (dates.length > 0 && now - dates[0] <= ONE_DAY + 60_000) {
    currentStreak = streak;
  }

  // Repeat runs on same route
  const routeFingerprints = new Map<string, number>();
  for (const r of routes) {
    const fp = `${r.name}::${(r.date?.split("T")[0] ?? r.date) as string}`;
    routeFingerprints.set(fp, (routeFingerprints.get(fp) ?? 0) + 1);
  }
  const maxRunsOnSingleRoute = Math.max(...routeFingerprints.values(), 1);

  return {
    totalRuns,
    totalDistanceKm,
    totalElevationM,
    countriesRun: new Set<string>(),
    routeCountries: new Map<string, Set<string>>(),
    clubMemberships: [],
    hasRunClub: false,
    maxRunsOnSingleRoute,
    longestRunKm,
    totalCountries: countryBuckets,
    currentStreak,
    longestStreak,
  };
}

function BadgeCard({ badge, earned, progress }: { badge: (typeof BADGE_DEFINITIONS)[0]; earned: boolean; progress: string }) {
  const cfg = TIER_CONFIG[badge.tier];
  return (
    <div className={`relative flex flex-col items-center p-4 rounded-2xl transition-all ${earned ? cfg.bg : "bg-surface-container"} ${earned ? `border ${cfg.border}` : "border border-outline-variant/20"}`}>
      <div className={`absolute top-3 right-3 text-[9px] font-extrabold uppercase tracking-widest ${earned ? cfg.text : "text-on-surface-variant"}`}>
        {cfg.label}
      </div>
      <div className={`w-12 h-12 rounded-2xl flex items-center justify-center mb-3 ${earned ? "bg-primary-container" : "bg-surface-container-high"}`}>
        <span className={`material-symbols-outlined text-2xl ${earned ? "text-primary" : "text-on-surface-variant/40"}`}>{badge.icon}</span>
      </div>
      <p className={`text-xs font-extrabold text-center mb-1 ${earned ? "text-on-surface" : "text-on-surface-variant/60"}`}>
        {badge.name}
      </p>
      <p className={`text-[10px] text-center leading-relaxed mb-3 ${earned ? "text-on-surface-variant" : "text-on-surface-variant/40"}`}>
        {badge.description}
      </p>
      {earned ? (
        <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-bold ${cfg.bg} ${cfg.text}`}>
          <span className="material-symbols-outlined text-xs">{cfg.icon}</span>
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

  const { routes } = useGPXRoutes(user?.uid ?? null);
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
        onLogout={async () => {}}
        fileInputRef={{ current: null } as React.RefObject<HTMLInputElement>}
        onFileUpload={() => {}}
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
                  <span className="text-sm font-extrabold" style={{ color: config.color }}>
                    {config.icon} {config.label}
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
    </div>
  );
}
