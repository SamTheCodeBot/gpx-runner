/**
 * Achievement Badge System — 30+ badges across 8 categories.
 */

import type { GPXRoute } from "@/app/types";

export interface BadgeContext {
  totalRuns: number;
  totalDistanceKm: number;
  totalElevationM: number;
  countriesRun: Set<string>;
  routeCountries: Map<string, Set<string>>;
  clubMemberships: string[];
  hasRunClub: boolean;
  maxRunsOnSingleRoute: number;
  longestRunKm: number;
  totalCountries: Set<string>;
  currentStreak: number;
  longestStreak: number;
}

export function computeBadgeContext(routes: GPXRoute[], clubMemberships: string[] = []): BadgeContext {
  const totalRuns = routes.length;
  const totalDistanceKm = routes.reduce((s, r) => s + (r.distance || 0) / 1000, 0);
  const totalElevationM = routes.reduce((s, r) => s + (r.elevationGain || 0), 0);
  const longestRunKm = routes.reduce((best, r) => Math.max(best, (r.distance || 0) / 1000), 0);

  const countryBuckets = new Set<string>();
  for (const r of routes) {
    if (!r.coordinates?.length) continue;
    const mid = r.coordinates[Math.floor(r.coordinates.length / 2)];
    const [lng, lat] = mid;
    countryBuckets.add(`${lat.toFixed(1)},${lng.toFixed(1)}`);
  }

  const dates = routes
    .map((r) => (r.date?.split("T")[0] ?? r.date) as string)
    .filter(Boolean)
    .map((d) => new Date(d).valueOf())
    .sort((a, b) => b - a);

  let longestStreak = 0, streak = 1;
  for (let i = 0; i < dates.length - 1; i++) {
    const diff = dates[i] - dates[i + 1];
    const ONE_DAY = 86_400_000;
    if (diff >= ONE_DAY - 60_000 && diff <= ONE_DAY + 60_000) { streak++; }
    else { longestStreak = Math.max(longestStreak, streak); streak = 1; }
  }
  longestStreak = Math.max(longestStreak, streak);
  let currentStreak = 0;
  const now = Date.now();
  if (dates.length > 0 && now - dates[0] <= 86_400_000 + 60_000) currentStreak = streak;

  const routeFingerprints = new Map<string, number>();
  for (const r of routes) {
    const fp = `${r.name}::${(r.date?.split("T")[0] ?? r.date) as string}`;
    routeFingerprints.set(fp, (routeFingerprints.get(fp) ?? 0) + 1);
  }

  return {
    totalRuns, totalDistanceKm, totalElevationM,
    countriesRun: new Set(), routeCountries: new Map(),
    clubMemberships, hasRunClub: clubMemberships.length > 0,
    maxRunsOnSingleRoute: Math.max(...routeFingerprints.values(), 1),
    longestRunKm, totalCountries: countryBuckets,
    currentStreak, longestStreak,
  };
}

export type BadgeTier = "bronze" | "silver" | "gold" | "platinum";

export interface BadgeDefinition {
  id: string; name: string; description: string;
  tier: BadgeTier; icon: string; category: string;
  check: (ctx: BadgeContext) => boolean;
  progress?: (ctx: BadgeContext) => string;
}

export const BADGE_DEFINITIONS: BadgeDefinition[] = [
  // Distance
  { id: "distance-10km",   name: "First 10K",       description: "Logged 10 km total",         tier: "bronze",   icon: "straighten",         category: "Distance",     check: (c) => c.totalDistanceKm >= 10,    progress: (c) => `${c.totalDistanceKm.toFixed(0)}/10 km` },
  { id: "distance-100km",  name: "Century",          description: "Logged 100 km total",        tier: "bronze",   icon: "directions_run",    category: "Distance",     check: (c) => c.totalDistanceKm >= 100,   progress: (c) => `${c.totalDistanceKm.toFixed(0)}/100 km` },
  { id: "distance-500km",  name: "Half Grand",       description: "Logged 500 km total",        tier: "silver",   icon: "social_distance",   category: "Distance",     check: (c) => c.totalDistanceKm >= 500,   progress: (c) => `${c.totalDistanceKm.toFixed(0)}/500 km` },
  { id: "distance-1000km", name: "Grand Slammer",    description: "Logged 1,000 km total",       tier: "gold",     icon: "sports_score",      category: "Distance",     check: (c) => c.totalDistanceKm >= 1000,  progress: (c) => `${c.totalDistanceKm.toFixed(0)}/1,000 km` },
  { id: "distance-5000km", name: "Ultra Runner",     description: "Logged 5,000 km total",      tier: "platinum", icon: "military_tech",     category: "Distance",     check: (c) => c.totalDistanceKm >= 5000,  progress: (c) => `${c.totalDistanceKm.toFixed(0)}/5,000 km` },
  // Elevation
  { id: "elevation-500m",  name: "Hill Hopper",      description: "Gained 500 m elevation",     tier: "bronze",   icon: "terrain",           category: "Elevation",    check: (c) => c.totalElevationM >= 500,    progress: (c) => `${c.totalElevationM.toFixed(0)}/500 m` },
  { id: "elevation-2000m", name: "Mountain Goat",    description: "Gained 2,000 m elevation",   tier: "silver",   icon: "landscape",         category: "Elevation",    check: (c) => c.totalElevationM >= 2000,   progress: (c) => `${c.totalElevationM.toFixed(0)}/2,000 m` },
  { id: "elevation-5000m", name: "Summit Seeker",    description: "Gained 5,000 m elevation",   tier: "gold",     icon: "hiking",            category: "Elevation",    check: (c) => c.totalElevationM >= 5000,   progress: (c) => `${c.totalElevationM.toFixed(0)}/5,000 m` },
  { id: "elevation-10000m",name: "Everest Chaser",  description: "Gained 10,000 m elevation",  tier: "platinum", icon: "pk",                category: "Elevation",    check: (c) => c.totalElevationM >= 10000,  progress: (c) => `${c.totalElevationM.toFixed(0)}/10,000 m` },
  // Countries
  { id: "country-1",      name: "Border Runner",    description: "Ran in 1 country",           tier: "bronze",   icon: "public",            category: "Countries",   check: (c) => c.totalCountries.size >= 1,  progress: (c) => `${c.totalCountries.size}/1 country` },
  { id: "country-3",      name: "Tourist",          description: "Ran in 3 countries",         tier: "silver",   icon: "travel_explore",    category: "Countries",   check: (c) => c.totalCountries.size >= 3,  progress: (c) => `${c.totalCountries.size}/3 countries` },
  { id: "country-5",      name: "Globe Trotter",    description: "Ran in 5 countries",         tier: "gold",     icon: "globe_uk",          category: "Countries",   check: (c) => c.totalCountries.size >= 5,  progress: (c) => `${c.totalCountries.size}/5 countries` },
  { id: "country-10",     name: "World Explorer",   description: "Ran in 10 countries",        tier: "platinum", icon: "earthquake",        category: "Countries",   check: (c) => c.totalCountries.size >= 10, progress: (c) => `${c.totalCountries.size}/10 countries` },
  { id: "cross-border",   name: "Cross Border",     description: "Ran across an international border", tier: "gold", icon: "connecting_airports", category: "Countries", check: () => false, progress: () => "0/1 crossing" },
  // Streak
  { id: "streak-3",       name: "Hat Trick",        description: "Ran 3 days in a row",        tier: "bronze",   icon: "local_fire_department", category: "Streak", check: (c) => c.longestStreak >= 3,   progress: (c) => `${c.longestStreak}/3 days` },
  { id: "streak-7",       name: "Week Warrior",     description: "Ran 7 days in a row",        tier: "silver",   icon: "whatshot",          category: "Streak",      check: (c) => c.longestStreak >= 7,   progress: (c) => `${c.longestStreak}/7 days` },
  { id: "streak-30",      name: "Monthly Machine",  description: "Ran 30 days in a row",      tier: "gold",     icon: "bolt",              category: "Streak",      check: (c) => c.longestStreak >= 30,  progress: (c) => `${c.longestStreak}/30 days` },
  { id: "streak-100",     name: "Unstoppable",      description: "Ran 100 days in a row",      tier: "platinum", icon: "rocket_launch",     category: "Streak",      check: (c) => c.longestStreak >= 100, progress: (c) => `${c.longestStreak}/100 days` },
  // Repeat Routes
  { id: "repeat-2",       name: "Loyal Route",      description: "Ran same route twice",       tier: "bronze",   icon: "route",              category: "Repeat Routes", check: (c) => c.maxRunsOnSingleRoute >= 2, progress: (c) => `${c.maxRunsOnSingleRoute}/2 runs` },
  { id: "repeat-5",       name: "Route Devotee",    description: "Ran same route 5 times",     tier: "silver",   icon: "add_location_alt",  category: "Repeat Routes", check: (c) => c.maxRunsOnSingleRoute >= 5, progress: (c) => `${c.maxRunsOnSingleRoute}/5 runs` },
  { id: "repeat-10",      name: "Route Ritual",     description: "Ran same route 10 times",    tier: "gold",     icon: "turn_left",          category: "Repeat Routes", check: (c) => c.maxRunsOnSingleRoute >= 10, progress: (c) => `${c.maxRunsOnSingleRoute}/10 runs` },
  // Single Run Distance
  { id: "single-5km",     name: "5K Finisher",      description: "Completed a 5 km run",       tier: "bronze",   icon: "timer",             category: "Single Run",  check: (c) => c.longestRunKm >= 5,     progress: (c) => `${c.longestRunKm.toFixed(1)}/5 km` },
  { id: "single-10km",   name: "10K Strong",       description: "Completed a 10 km run",       tier: "silver",   icon: "speed",             category: "Single Run",  check: (c) => c.longestRunKm >= 10,    progress: (c) => `${c.longestRunKm.toFixed(1)}/10 km` },
  { id: "single-21km",   name: "Half Marathoner",  description: "Completed a half marathon",  tier: "gold",     icon: "directions_run",    category: "Single Run",  check: (c) => c.longestRunKm >= 21.1,  progress: (c) => `${c.longestRunKm.toFixed(1)}/21.1 km` },
  { id: "single-42km",   name: "Marathon Legend",  description: "Completed a full marathon",  tier: "platinum", icon: "emoji_events",      category: "Single Run",  check: (c) => c.longestRunKm >= 42.2,  progress: (c) => `${c.longestRunKm.toFixed(1)}/42.2 km` },
  // Frequency
  { id: "runs-10",       name: "Getting Started",  description: "Logged 10 runs",             tier: "bronze",   icon: "numbers",           category: "Frequency",    check: (c) => c.totalRuns >= 10,  progress: (c) => `${c.totalRuns}/10 runs` },
  { id: "runs-50",       name: "Regular Runner",   description: "Logged 50 runs",             tier: "silver",   icon: "format_list_numbered", category: "Frequency", check: (c) => c.totalRuns >= 50, progress: (c) => `${c.totalRuns}/50 runs` },
  { id: "runs-100",      name: "Centurion",        description: "Logged 100 runs",            tier: "gold",     icon: "looks_one",         category: "Frequency",   check: (c) => c.totalRuns >= 100, progress: (c) => `${c.totalRuns}/100 runs` },
  { id: "runs-500",      name: "Ultra Dedicated",  description: "Logged 500 runs",            tier: "platinum", icon: "star",              category: "Frequency",   check: (c) => c.totalRuns >= 500, progress: (c) => `${c.totalRuns}/500 runs` },
  // Clubs
  { id: "club-join",     name: "Club Member",      description: "Joined a run club",          tier: "bronze",   icon: "groups",            category: "Clubs",        check: (c) => c.hasRunClub,       progress: (c) => `${c.clubMemberships.length}/1 club` },
  { id: "club-multi",    name: "Social Runner",    description: "Joined 3+ run clubs",        tier: "silver",   icon: "diversity_3",       category: "Clubs",        check: (c) => c.clubMemberships.length >= 3, progress: (c) => `${c.clubMemberships.length}/3 clubs` },
  { id: "club-creator",  name: "Captain",          description: "Created your own run club",  tier: "gold",     icon: "shield",            category: "Clubs",        check: () => false, progress: () => "0/1 club created" },
  { id: "club-run-together", name: "Group Runner", description: "Joined a public group run",  tier: "silver",   icon: "accessibility_new", category: "Clubs",        check: () => false, progress: () => "0/1 group run" },
];

export function getEarnedBadgeIds(ctx: BadgeContext): Set<string> {
  const earned = new Set<string>();
  for (const b of BADGE_DEFINITIONS) { if (b.check(ctx)) earned.add(b.id); }
  return earned;
}
