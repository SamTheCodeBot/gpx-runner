import { FamiliarityMode } from "../types";
import { familiarityRangeForMode } from "./config";

/**
 * The vocabulary the product (and the UI) uses. The engine internally calls the
 * low-familiarity mode "new"; the user story calls it "unfamiliar".
 */
export type FamiliarityTarget = "familiar" | "mixed" | "unfamiliar";

export const FAMILIARITY_TARGETS: FamiliarityTarget[] = ["familiar", "mixed", "unfamiliar"];

export function isFamiliarityTarget(value: unknown): value is FamiliarityTarget {
  return typeof value === "string" && (FAMILIARITY_TARGETS as string[]).includes(value);
}

export function toEngineMode(target: FamiliarityTarget): FamiliarityMode {
  return target === "unfamiliar" ? "new" : target;
}

export function toFamiliarityTarget(mode: FamiliarityMode): FamiliarityTarget {
  return mode === "new" ? "unfamiliar" : mode;
}

export function familiarityBand(target: FamiliarityTarget): { min: number; max: number } {
  return familiarityRangeForMode(toEngineMode(target));
}

export type FamiliarityReport = {
  /** 0..1, or null when the user has no logged activity near the start point. */
  ratio: number | null;
  /** Whole percent, or null when unmeasurable. */
  percent: number | null;
  target: FamiliarityTarget;
  min: number;
  max: number;
  withinTarget: boolean;
  hasHistory: boolean;
  /** Plain-language sentence for the UI. Always safe to show. */
  message: string;
};

export function buildFamiliarityReport(input: {
  ratio: number | null;
  target: FamiliarityTarget;
  hasHistory: boolean;
}): FamiliarityReport {
  const { min, max } = familiarityBand(input.target);
  const ratio =
    input.hasHistory && input.ratio !== null && Number.isFinite(input.ratio)
      ? Math.max(0, Math.min(1, input.ratio))
      : null;
  const percent = ratio === null ? null : Math.round(ratio * 100);
  const withinTarget = ratio !== null && ratio >= min && ratio <= max;

  return {
    ratio,
    percent,
    target: input.target,
    min,
    max,
    withinTarget,
    hasHistory: input.hasHistory,
    message: familiarityMessage({ percent, target: input.target, withinTarget, hasHistory: input.hasHistory }),
  };
}

function familiarityMessage(input: {
  percent: number | null;
  target: FamiliarityTarget;
  withinTarget: boolean;
  hasHistory: boolean;
}): string {
  if (!input.hasHistory || input.percent === null) {
    return "No logged runs near this start point yet, so familiarity could not be measured for this route.";
  }

  const percent = input.percent;

  if (input.withinTarget) {
    if (input.target === "unfamiliar") {
      return `Only ${percent}% of this route is ground you have run before — that is new territory.`;
    }
    if (input.target === "familiar") {
      return `You've run ${percent}% of this route before.`;
    }
    return `You've run ${percent}% of this route before — a mix of known and new ground.`;
  }

  if (input.target === "familiar") {
    return `Closest match: ${percent}% familiar — not enough of it is ground you already know for a familiar route.`;
  }

  if (input.target === "unfamiliar") {
    return `Closest match: ${percent}% familiar — not enough new ground for an unfamiliar route.`;
  }

  return percent > 80
    ? `You've run ${percent}% of this route before — more familiar than a mixed route asks for.`
    : `You've run ${percent}% of this route before — less familiar than a mixed route asks for.`;
}
