import { FamiliarityMode } from "../types";

export function familiarityRangeForMode(mode: FamiliarityMode): { min: number; max: number } {
  switch (mode) {
    case "familiar":
      return { min: 0.7, max: 1 };
    case "new":
      return { min: 0, max: 0.2 };
    case "mixed":
    default:
      return { min: 0.3, max: 0.7 };
  }
}
