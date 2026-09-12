import { FamiliaritySearchEvidence, LatLng } from "../types";
import { lowestPredictedKnownness } from "./candidates";
import type { FamiliarityIndex } from "./familiarity";
import { familiarityBand, type FamiliarityTarget } from "./familiarityReport";

/**
 * What to say when the familiarity band cannot be reached.
 *
 * The owner's words: *"It should rather tell me that instead of trying to map
 * something out. Maybe with the advice to increase the length or choose another
 * start point."* Handing back a 20%-or-less request as an 87%-familiar loop is
 * not a best effort, it is a wrong answer delivered confidently.
 *
 * The hard part is saying it honestly. This app has **no street inventory**. It
 * knows every metre the runner has logged and nothing at all about the roads he
 * has not run, so it can never say what fraction of the neighbourhood he has
 * covered — that number is not computable from anything here. Every sentence
 * below is therefore built from two things only: the loops this search actually
 * drew and measured, and the runner's own recorded history read as a grid of
 * where he has been.
 */

/**
 * How far outside the band a route may sit and still be worth showing.
 *
 * Inside this, the measured percentage is useful information — "closest match:
 * 31% familiar" tells a runner something true about the run he is being
 * offered, and he can take it or leave it. Beyond it, the route is not a near
 * miss at all: at 43% against a band of 20% or less, it is a different run from
 * the one that was asked for, and presenting it as the answer is what wasted
 * the owner's afternoon.
 */
export const NEAR_MISS_SHOWABLE_BAND_DISTANCE = 0.15;

/**
 * How many measured loops it takes before "this cannot be done here" is a
 * finding rather than a guess. Below this the search has not looked hard enough
 * to make a claim, so the near miss is shown with its true percentage instead.
 */
export const MIN_LOOPS_FOR_UNREACHABLE_VERDICT = 3;

/** How much further than the request the advice is willing to look. */
const LONGER_DISTANCE_PROBES = [1.5, 2, 3, 4];

export type FamiliarityOutcome = "show-near-miss" | "band-unreachable";

export function familiarityBandDistance(ratio: number, range: { min: number; max: number }): number {
  if (ratio < range.min) return range.min - ratio;
  if (ratio > range.max) return ratio - range.max;
  return 0;
}

/**
 * The rule, in one place: show the near miss, or admit the band is out of reach.
 */
export function decideFamiliarityOutcome(input: {
  /** Familiarity of the best thing the search can offer, or null if unmeasurable. */
  bestRatio: number | null;
  target: FamiliarityTarget;
  evidence: FamiliaritySearchEvidence;
}): FamiliarityOutcome {
  if (input.bestRatio === null || !Number.isFinite(input.bestRatio)) return "show-near-miss";

  const band = familiarityBand(input.target);
  if (familiarityBandDistance(input.bestRatio, band) <= NEAR_MISS_SHOWABLE_BAND_DISTANCE) {
    return "show-near-miss";
  }

  if (input.evidence.loopsMeasured < MIN_LOOPS_FOR_UNREACHABLE_VERDICT) return "show-near-miss";

  return "band-unreachable";
}

/**
 * The distance at which this runner's *own logged ground* runs out.
 *
 * Builds the same offset loops the search builds, at a few longer distances,
 * and asks the coverage grid how much of each would be on ground he has already
 * covered. It is a prediction from his history, not a promise about roads — no
 * provider is called and nothing here knows whether those streets exist.
 * Returns null when no probed length would get clear of his history.
 */
export function probeDistanceForBand(input: {
  start: LatLng;
  index: FamiliarityIndex;
  requestedMeters: number;
  target: FamiliarityTarget;
}): { suggestedMeters: number | null; probedToMeters: number } {
  const band = familiarityBand(input.target);
  const probedToMeters = input.requestedMeters * LONGER_DISTANCE_PROBES[LONGER_DISTANCE_PROBES.length - 1];

  for (const multiplier of LONGER_DISTANCE_PROBES) {
    const meters = input.requestedMeters * multiplier;
    const predicted = lowestPredictedKnownness(input.start, meters, input.index);
    if (predicted !== null && predicted <= band.max && predicted >= band.min) {
      return { suggestedMeters: meters, probedToMeters };
    }
  }

  return { suggestedMeters: null, probedToMeters };
}

/**
 * The sentence the runner gets. Counts and measurements only — never a fraction
 * of the streets nearby, which nothing in this app can know.
 */
export function describeUnreachableBand(input: {
  target: FamiliarityTarget;
  evidence: FamiliaritySearchEvidence;
  requestedMeters: number;
  suggestedMeters: number | null;
  probedToMeters: number;
}): string {
  const band = familiarityBand(input.target);
  const { loopsMeasured, lowestFamiliarity, highestFamiliarity, searchRadiusMeters } = input.evidence;

  const observed =
    input.target === "familiar"
      ? `the most familiar was ${percent(highestFamiliarity)} ground you have run before`
      : `the least familiar was ${percent(lowestFamiliarity)} ground you have run before`;

  const asked =
    input.target === "unfamiliar"
      ? `${percent(band.max)} or less`
      : input.target === "familiar"
        ? `${percent(band.min)} or more`
        : `between ${percent(band.min)} and ${percent(band.max)}`;

  const finding =
    `Every loop we could draw from this start point came back outside what you asked for. ` +
    `We drew ${loopsMeasured} of them, reaching ${km(searchRadiusMeters)} from the start, and ${observed} — ` +
    `this setting asks for ${asked}.`;

  return `${finding} ${lever(input)}`;
}

function lever(input: {
  target: FamiliarityTarget;
  requestedMeters: number;
  suggestedMeters: number | null;
  probedToMeters: number;
}): string {
  if (input.target === "familiar") {
    return (
      `Two things move it: a shorter run, or a start point closer to the ground you already know.`
    );
  }

  if (input.target === "mixed") {
    return `Two things move it: a different distance, or a different start point.`;
  }

  if (input.suggestedMeters !== null) {
    return (
      `Two things move it. A longer run: from this start, a loop of about ${km(input.suggestedMeters)} ` +
      `would spend most of its length beyond anything you have logged. Or a different start point.`
    );
  }

  return (
    `Two things move it: a longer run, or a different start point. ` +
    `We looked at loops up to ${km(input.probedToMeters)} from here and none of them would get clear of ` +
    `the ground you have already logged, so a different start point is the surer lever.`
  );
}

function percent(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return "an unmeasured amount of";
  return `${Math.round(ratio * 100)}%`;
}

function km(meters: number): string {
  return `${(meters / 1000).toFixed(1)} km`;
}
