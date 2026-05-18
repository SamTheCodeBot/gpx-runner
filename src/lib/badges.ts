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
  routeTypes: Set<string>;
  maxRunsOnSingleRoute: number;
  longestRunKm: number;
  totalCountries: Set<string>; // unique countries across all routes
  currentStreak: number; // consecutive days with runs
  longestStreak: number;
  routesWithTcx: number;
  roundTripRuns: number;
  uniqueRouteFingerprints: number;
  distinctAreas: number;
  hasWeekendPair: boolean;
  hasFullCalendarYear: boolean;
  hasWinterSeason: boolean;
  hasSummerSeason: boolean;
  earlyRuns: number;
  nightRuns: number;
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
    id: "dist-2500",
    name: "Distance Collector",
    description: "Run a total of 2,500 km",
    icon: "route",
    tier: "gold",
    check: (c) => c.totalDistanceKm >= 2500,
    progress: (c) => `${c.totalDistanceKm.toFixed(0)} / 2,500 km`,
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
  {
    id: "dist-25000",
    name: "Lifetime Engine",
    description: "Run a lifetime total of 25,000 km",
    icon: "all_inclusive",
    tier: "platinum",
    check: (c) => c.totalDistanceKm >= 25000,
    progress: (c) => `${c.totalDistanceKm.toFixed(0)} / 25,000 km`,
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
  {
    id: "elev-25000",
    name: "Vertical Beast",
    description: "Accumulate 25,000 m of elevation gain",
    icon: "landscape",
    tier: "platinum",
    check: (c) => c.totalElevationM >= 25000,
    progress: (c) => `${c.totalElevationM.toFixed(0)} / 25,000 m`,
  },
  {
    id: "elev-50000",
    name: "Sky Chaser",
    description: "Accumulate 50,000 m of elevation gain",
    icon: "filter_hdr",
    tier: "platinum",
    check: (c) => c.totalElevationM >= 50000,
    progress: (c) => `${c.totalElevationM.toFixed(0)} / 50,000 m`,
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
    id: "runs-200",
    name: "Run Machine",
    description: "Log 200 runs",
    icon: "directions_run",
    tier: "gold",
    check: (c) => c.totalRuns >= 200,
    progress: (c) => `${c.totalRuns} / 200 runs`,
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
  {
    id: "runs-1000",
    name: "Four Digit Runner",
    description: "Log 1,000 runs",
    icon: "workspace_premium",
    tier: "platinum",
    check: (c) => c.totalRuns >= 1000,
    progress: (c) => `${c.totalRuns} / 1,000 runs`,
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
    check: (c) => Array.from(c.routeCountries.values()).some((countries) => countries.size >= 2),
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
  {
    id: "weekend-warrior",
    name: "Weekend Warrior",
    description: "Run on both Saturday and Sunday in the same weekend",
    icon: "weekend",
    tier: "bronze",
    check: (c) => c.hasWeekendPair,
    progress: () => "Run on Saturday and Sunday",
  },
  {
    id: "calendar-year",
    name: "Month Completer",
    description: "Run at least once in every month of a calendar year",
    icon: "event_available",
    tier: "gold",
    check: (c) => c.hasFullCalendarYear,
    progress: () => "Run in all 12 months of one year",
  },
  {
    id: "winter-runner",
    name: "Winter Runner",
    description: "Run in December, January, and February",
    icon: "ac_unit",
    tier: "silver",
    check: (c) => c.hasWinterSeason,
    progress: () => "Run in Dec, Jan, and Feb",
  },
  {
    id: "summer-runner",
    name: "Summer Streaker",
    description: "Run in June, July, and August",
    icon: "wb_sunny",
    tier: "silver",
    check: (c) => c.hasSummerSeason,
    progress: () => "Run in Jun, Jul, and Aug",
  },
  {
    id: "early-bird",
    name: "Early Bird",
    description: "Log a run that starts before 07:00",
    icon: "wb_twilight",
    tier: "bronze",
    check: (c) => c.earlyRuns >= 1,
    progress: () => "Start a run before 07:00",
  },
  {
    id: "night-runner",
    name: "Night Runner",
    description: "Log a run that starts after 21:00",
    icon: "dark_mode",
    tier: "bronze",
    check: (c) => c.nightRuns >= 1,
    progress: () => "Start a run after 21:00",
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
  {
    id: "fresh-paths",
    name: "Fresh Paths",
    description: "Log 10 distinct route shapes",
    icon: "explore",
    tier: "silver",
    check: (c) => c.uniqueRouteFingerprints >= 10,
    progress: (c) => `${c.uniqueRouteFingerprints} / 10 unique routes`,
  },
  {
    id: "area-10",
    name: "Explorer Mode",
    description: "Run in 10 distinct areas",
    icon: "travel_explore",
    tier: "gold",
    check: (c) => c.distinctAreas >= 10,
    progress: (c) => `${c.distinctAreas} / 10 areas`,
  },

  // ── Single run distance ──────────────────────────────────────────────
  {
    id: "single-5",
    name: "First 5K",
    description: "Complete a single run of 5 km or more",
    icon: "sprint",
    tier: "bronze",
    check: (c) => c.longestRunKm >= 5,
    progress: (c) => `Longest run: ${c.longestRunKm.toFixed(1)} km`,
  },
  {
    id: "single-10",
    name: "First 10K",
    description: "Complete a single run of 10 km or more",
    icon: "sprint",
    tier: "bronze",
    check: (c) => c.longestRunKm >= 10,
    progress: (c) => `Longest run: ${c.longestRunKm.toFixed(1)} km`,
  },
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
    id: "single-50",
    name: "Ultra Starter",
    description: "Complete a single run of 50 km or more",
    icon: "sprint",
    tier: "platinum",
    check: (c) => c.longestRunKm >= 50,
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

  // ── Variety badges ─────────────────────────────────────────────────
  {
    id: "type-road",
    name: "Asphalt Ace",
    description: "Log your first road run",
    icon: "directions_bike",
    tier: "bronze",
    check: (c) => c.routeTypes.has("road"),
    progress: () => "Log a road run",
  },
  {
    id: "type-trail",
    name: "Trail Blazer",
    description: "Log your first trail run",
    icon: "hiking",
    tier: "bronze",
    check: (c) => c.routeTypes.has("trail"),
    progress: () => "Log a trail run",
  },
  {
    id: "type-mixed",
    name: "Hybrid Hero",
    description: "Log a mixed road/trail run",
    icon: "terrain",
    tier: "bronze",
    check: (c) => c.routeTypes.has("mixed"),
    progress: () => "Log a mixed run",
  },
  {
    id: "round-trip-1",
    name: "Round Tripper",
    description: "Complete one round-trip route",
    icon: "sync",
    tier: "bronze",
    check: (c) => c.roundTripRuns >= 1,
    progress: (c) => `${c.roundTripRuns} / 1 round trip`,
  },
  {
    id: "round-trip-10",
    name: "Loop Lover",
    description: "Complete 10 round-trip routes",
    icon: "all_inclusive",
    tier: "silver",
    check: (c) => c.roundTripRuns >= 10,
    progress: (c) => `${c.roundTripRuns} / 10 round trips`,
  },
  {
    id: "tcx-1",
    name: "Data Nerd",
    description: "Upload a route with TCX metrics",
    icon: "monitor_heart",
    tier: "bronze",
    check: (c) => c.routesWithTcx >= 1,
    progress: (c) => `${c.routesWithTcx} / 1 TCX route`,
  },
  {
    id: "tcx-10",
    name: "Metric Master",
    description: "Upload 10 routes with TCX metrics",
    icon: "query_stats",
    tier: "silver",
    check: (c) => c.routesWithTcx >= 10,
    progress: (c) => `${c.routesWithTcx} / 10 TCX routes`,
  },
];

export function evaluateBadges(ctx: BadgeContext): string[] {
  return BADGE_DEFINITIONS.filter((b) => b.check(ctx)).map((b) => b.id);
}
