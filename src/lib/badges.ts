// Badge definitions for GPX Running
// Each badge has: id, name, description, icon, criteria, tier

export interface BadgeDefinition {
  id: string;
  name: string;
  description: string;
  icon: string; // Material Symbols icon name
  // Material Symbols filled variants for earned, outlined for locked
  tier: "bronze" | "silver" | "gold" | "platinum";
  // Criteria check function — returns true if earned
  check: (ctx: BadgeContext) => boolean;
  // Progress text when not yet earned
  progress?: (ctx: BadgeContext) => string;
}

export interface BadgeContext {
  totalRuns: number;
  totalDistanceKm: number;
  totalElevationM: number;
  countriesRun: Set<string>;
  routeCountries: Map<string, Set<string>>; // routeId → Set of countries
  clubMemberships: string[];
  hasRunClub: boolean;
  maxRunsOnSingleRoute: number;
  longestRunKm: number;
  totalCountries: Set<string>; // unique countries across all routes
  currentStreak: number; // consecutive days with runs
  longestStreak: number;
}

export const BADGE_DEFINITIONS: BadgeDefinition[] = [
  // ── Distance milestones ──────────────────────────────────────────────
  {
    id: "dist-100",
    name: "First Century",
    description: "Run a total of 100 km",
    icon: "straighten",
    tier: "bronze",
    check: (c) => c.totalDistanceKm >= 100,
    progress: (c) => `${c.totalDistanceKm.toFixed(0)} / 100 km`,
  },
  {
    id: "dist-500",
    name: "Half Grand",
    description: "Run a total of 500 km",
    icon: "straighten",
    tier: "silver",
    check: (c) => c.totalDistanceKm >= 500,
    progress: (c) => `${c.totalDistanceKm.toFixed(0)} / 500 km`,
  },
  {
    id: "dist-1000",
    name: "Grand Centurion",
    description: "Run a total of 1,000 km — that's 24.8 miles!",
    icon: "military_tech",
    tier: "gold",
    check: (c) => c.totalDistanceKm >= 1000,
    progress: (c) => `${c.totalDistanceKm.toFixed(0)} / 1,000 km`,
  },
  {
    id: "dist-5000",
    name: "Ultra Voyager",
    description: "Run a total of 5,000 km — equivalent to Oslo→Tokyo",
    icon: "public",
    tier: "platinum",
    check: (c) => c.totalDistanceKm >= 5000,
    progress: (c) => `${c.totalDistanceKm.toFixed(0)} / 5,000 km`,
  },
  {
    id: "dist-10000",
    name: "Planet Walker",
    description: "Run a total of 10,000 km — nearly the Earth's circumference",
    icon: "地球",
    tier: "platinum",
    check: (c) => c.totalDistanceKm >= 10000,
    progress: (c) => `${c.totalDistanceKm.toFixed(0)} / 10,000 km`,
  },

  // ── Elevation milestones ──────────────────────────────────────────────
  {
    id: "elev-1000",
    name: "Mountain Mover",
    description: "Accumulate 1,000 m of elevation gain",
    icon: "terrain",
    tier: "bronze",
    check: (c) => c.totalElevationM >= 1000,
    progress: (c) => `${c.totalElevationM.toFixed(0)} / 1,000 m`,
  },
  {
    id: "elev-5000",
    name: "Summit Seeker",
    description: "Accumulate 5,000 m of elevation gain — Everest base camp!",
    icon: "terrain",
    tier: "silver",
    check: (c) => c.totalElevationM >= 5000,
    progress: (c) => `${c.totalElevationM.toFixed(0)} / 5,000 m`,
  },
  {
    id: "elev-10000",
    name: "Peak Bagger",
    description: "Accumulate 10,000 m of elevation — climb Everest twice",
    icon: "terrain",
    tier: "gold",
    check: (c) => c.totalElevationM >= 10000,
    progress: (c) => `${c.totalElevationM.toFixed(0)} / 10,000 m`,
  },

  // ── Run count milestones ──────────────────────────────────────────────
  {
    id: "runs-10",
    name: "Getting Warmed Up",
    description: "Log 10 runs",
    icon: "directions_run",
    tier: "bronze",
    check: (c) => c.totalRuns >= 10,
    progress: (c) => `${c.totalRuns} / 10 runs`,
  },
  {
    id: "runs-50",
    name: "Half Centurion",
    description: "Log 50 runs",
    icon: "directions_run",
    tier: "silver",
    check: (c) => c.totalRuns >= 50,
    progress: (c) => `${c.totalRuns} / 50 runs`,
  },
  {
    id: "runs-100",
    name: "Centurion",
    description: "Log 100 runs",
    icon: "directions_run",
    tier: "gold",
    check: (c) => c.totalRuns >= 100,
    progress: (c) => `${c.totalRuns} / 100 runs`,
  },
  {
    id: "runs-365",
    name: "Daily Devotion",
    description: "Log 365 runs — one for every day of the year",
    icon: "calendar_month",
    tier: "platinum",
    check: (c) => c.totalRuns >= 365,
    progress: (c) => `${c.totalRuns} / 365 runs`,
  },

  // ── Country / cross-border badges ────────────────────────────────────
  {
    id: "country-1",
    name: "Local Runner",
    description: "Run in at least 1 country",
    icon: "flag",
    tier: "bronze",
    check: (c) => c.totalCountries.size >= 1,
    progress: (c) => `${c.totalCountries.size} / 1 country`,
  },
  {
    id: "country-3",
    name: "Continental Explorer",
    description: "Run in at least 3 different countries",
    icon: "flag",
    tier: "silver",
    check: (c) => c.totalCountries.size >= 3,
    progress: (c) => `${c.totalCountries.size} / 3 countries`,
  },
  {
    id: "country-5",
    name: "Globe Trotter",
    description: "Run in at least 5 different countries",
    icon: "flag",
    tier: "gold",
    check: (c) => c.totalCountries.size >= 5,
    progress: (c) => `${c.totalCountries.size} / 5 countries`,
  },
  {
    id: "country-10",
    name: "World Wanderer",
    description: "Run in at least 10 different countries",
    icon: "travel_explore",
    tier: "platinum",
    check: (c) => c.totalCountries.size >= 10,
    progress: (c) => `${c.totalCountries.size} / 10 countries`,
  },
  {
    id: "cross-border",
    name: "Border Crosser",
    description: "Run between two different countries in a single run",
    icon: "swap_horiz",
    tier: "gold",
    check: (c) => false, // Requires route-level country detection — stub for future
    progress: () => "Run between two countries",
  },

  // ── Streak badges ────────────────────────────────────────────────────
  {
    id: "streak-7",
    name: "Week Warrior",
    description: "Maintain a 7-day running streak",
    icon: "local_fire_department",
    tier: "bronze",
    check: (c) => c.longestStreak >= 7,
    progress: (c) => `Best streak: ${c.longestStreak} days`,
  },
  {
    id: "streak-30",
    name: "Monthly Momentum",
    description: "Maintain a 30-day running streak",
    icon: "local_fire_department",
    tier: "silver",
    check: (c) => c.longestStreak >= 30,
    progress: (c) => `Best streak: ${c.longestStreak} days`,
  },
  {
    id: "streak-100",
    name: "Centurion Streak",
    description: "Maintain a 100-day running streak",
    icon: "local_fire_department",
    tier: "gold",
    check: (c) => c.longestStreak >= 100,
    progress: (c) => `Best streak: ${c.longestStreak} days`,
  },

  // ── Repeated route / consistency badges ─────────────────────────────
  {
    id: "repeat-3",
    name: "Route Loyalist",
    description: "Run the same route 3 times",
    icon: "repeat",
    tier: "bronze",
    check: (c) => c.maxRunsOnSingleRoute >= 3,
    progress: (c) => `Most repeats: ${c.maxRunsOnSingleRoute}×`,
  },
  {
    id: "repeat-10",
    name: "Route Devotee",
    description: "Run the same route 10 times — you really love that loop!",
    icon: "repeat",
    tier: "silver",
    check: (c) => c.maxRunsOnSingleRoute >= 10,
    progress: (c) => `Most repeats: ${c.maxRunsOnSingleRoute}×`,
  },
  {
    id: "repeat-25",
    name: "Loop Legend",
    description: "Run the same route 25 times — that's dedication!",
    icon: "emoji_events",
    tier: "gold",
    check: (c) => c.maxRunsOnSingleRoute >= 25,
    progress: (c) => `Most repeats: ${c.maxRunsOnSingleRoute}×`,
  },

  // ── Single run distance ──────────────────────────────────────────────
  {
    id: "single-21",
    name: "Half Marathon Hero",
    description: "Complete a single run of 21.1 km or more",
    icon: "sprint",
    tier: "silver",
    check: (c) => c.longestRunKm >= 21.1,
    progress: (c) => `Longest run: ${c.longestRunKm.toFixed(1)} km`,
  },
  {
    id: "single-42",
    name: "Full Marathon Master",
    description: "Complete a full marathon (42.2 km) in a single run",
    icon: "sprint",
    tier: "gold",
    check: (c) => c.longestRunKm >= 42.2,
    progress: (c) => `Longest run: ${c.longestRunKm.toFixed(1)} km`,
  },
  {
    id: "single-100",
    name: "Century Run",
    description: "Complete a 100 km run in a single go",
    icon: "sprint",
    tier: "platinum",
    check: (c) => c.longestRunKm >= 100,
    progress: (c) => `Longest run: ${c.longestRunKm.toFixed(1)} km`,
  },

  // ── Club badges ─────────────────────────────────────────────────────
  {
    id: "club-join",
    name: "Social Strider",
    description: "Join a run club",
    icon: "groups",
    tier: "bronze",
    check: (c) => c.clubMemberships.length >= 1,
    progress: (c) => `${c.clubMemberships.length} / 1 club`,
  },
  {
    id: "club-3",
    name: "Club Collector",
    description: "Join 3 different run clubs",
    icon: "groups",
    tier: "silver",
    check: (c) => c.clubMemberships.length >= 3,
    progress: (c) => `${c.clubMemberships.length} / 3 clubs`,
  },
  {
    id: "club-lead",
    name: "Club Captain",
    description: "Create or lead a run club",
    icon: "military_tech",
    tier: "gold",
    check: (c) => c.hasRunClub,
    progress: () => "Lead a run club",
  },

  // ── Variety badges ─────────────────────────────────────────────────
  {
    id: "type-road",
    name: "Asphalt Ace",
    description: "Log your first road run",
    icon: "directions_bike",
    tier: "bronze",
    check: () => false, // Requires type tracking — stub
    progress: () => "Log a road run",
  },
  {
    id: "type-trail",
    name: "Trail Blazer",
    description: "Log your first trail run",
    icon: "hiking",
    tier: "bronze",
    check: () => false,
    progress: () => "Log a trail run",
  },
  {
    id: "type-mixed",
    name: "Hybrid Hero",
    description: "Log a mixed road/trail run",
    icon: "terrain",
    tier: "bronze",
    check: () => false,
    progress: () => "Log a mixed run",
  },
];

export function evaluateBadges(ctx: BadgeContext): string[] {
  return BADGE_DEFINITIONS.filter((b) => b.check(ctx)).map((b) => b.id);
}
