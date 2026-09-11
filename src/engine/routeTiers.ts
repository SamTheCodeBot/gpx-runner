import { GeneratedRoute } from "../types";

/**
 * What the runner gets, and in what order.
 *
 * The product rule, in the owner's words: *"Sometimes an out and back might be
 * the only solution. But hey, then it is ok. But we should always try to avoid
 * it."*
 *
 * So loop shape is not a hard reject any more — but it is not a scoring weight
 * either. It is this list. Read it top to bottom: the first tier that has
 * anything in it is the answer, and an out-and-back is reachable only when
 * every tier above it came back empty. No amount of scoring can promote one
 * past a real loop, because the tiers are consulted in order and never mixed.
 *
 * What has *not* moved: the route must follow real ways. A there-and-back
 * along actual streets is a disappointment; a line across a housing estate and
 * a river is not a route at all. Every tier here, the last one included, is
 * drawn by the routing provider and checked for road safety.
 */
export const SUGGESTION_TIERS = [
  {
    id: "loop-familiarity-matched",
    isOutAndBack: false,
    /** A loop of the right length, on the mix of known ground that was asked for. */
    describe: () => null,
  },
  {
    id: "loop-familiarity-missed",
    isOutAndBack: false,
    /**
     * A loop of the right length whose familiarity lands outside the band. The
     * familiarity report already carries the honest percentage and sentence,
     * so nothing more needs saying here.
     */
    describe: () => null,
  },
  {
    id: "loop-round-trip",
    isOutAndBack: false,
    /** A loop from the plain round-trip generator, with no familiarity steering. */
    describe: () => null,
  },
  {
    id: "loop-off-distance",
    isOutAndBack: false,
    /** A real loop, the wrong length. Still a loop, so still ahead of a there-and-back. */
    describe: (context: TierContext) =>
      `No loop of ${formatKm(context.targetMeters)} could be found from this start point. ` +
      `This is the closest real loop, at ${formatKm(context.distanceMeters)}.`,
  },
  {
    id: "out-and-back",
    isOutAndBack: true,
    describe: (context: TierContext) =>
      `No loop was possible from this start at ${formatKm(context.targetMeters)} — ` +
      `this is an out-and-back, so you return the way you came.`,
  },
] as const satisfies readonly SuggestionTier[];

export type SuggestionTierId = (typeof SUGGESTION_TIERS)[number]["id"];

export type TierContext = {
  targetMeters: number;
  distanceMeters: number;
};

export type SuggestionTier = {
  id: string;
  isOutAndBack: boolean;
  describe: (context: TierContext) => string | null;
};

export type TierPick<T> = {
  tier: SuggestionTier;
  candidate: T;
};

/**
 * The first tier that has a candidate. `candidates` need not be complete —
 * a tier with nothing to offer is simply skipped.
 */
export function pickByTier<T>(
  candidates: Partial<Record<SuggestionTierId, T | undefined>>,
): TierPick<T> | null {
  for (const tier of SUGGESTION_TIERS) {
    const candidate = candidates[tier.id];
    if (candidate) return { tier, candidate };
  }
  return null;
}

/** True when a route came back as a there-and-back and the runner must be told. */
export function isOutAndBackRoute(route: Pick<GeneratedRoute, "isOutAndBack">): boolean {
  return route.isOutAndBack;
}

function formatKm(meters: number): string {
  return `${(meters / 1000).toFixed(1)} km`;
}
