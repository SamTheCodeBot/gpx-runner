import { FamiliarityMode } from "../types";

/**
 * Product thresholds (user story):
 *   familiar   — 80% or more of the route has been run before
 *   unfamiliar — 20% or less has been run before
 *   mixed      — anything in between
 */
export const FAMILIAR_MIN_RATIO = 0.8;
export const UNFAMILIAR_MAX_RATIO = 0.2;

export function familiarityRangeForMode(mode: FamiliarityMode): { min: number; max: number } {
  switch (mode) {
    case "familiar":
      return { min: FAMILIAR_MIN_RATIO, max: 1 };
    case "new":
      return { min: 0, max: UNFAMILIAR_MAX_RATIO };
    case "mixed":
    default:
      return { min: UNFAMILIAR_MAX_RATIO, max: FAMILIAR_MIN_RATIO };
  }
}
