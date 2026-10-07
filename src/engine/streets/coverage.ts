import { LatLng } from "../../types";
import { nearestFamiliarDistanceMeters, type FamiliarityIndex } from "../familiarity";
import { densifyPolyline, haversineMeters, midpoint, pointToSegmentDistanceMeters } from "../utils/geo";
import type { Street } from "./inventory";

/**
 * How much of a street the runner has actually run.
 *
 * This is the familiarity engine read in the other direction. That engine asks
 * "is this proposed route ground I know?" against a 40 m spatial grid built
 * from every logged track; here the question is "is this street ground I have
 * covered?", against the same index and the same corridor. One definition of
 * "I have been down there", used to suggest routes and to award streets — if
 * these drifted apart the app would congratulate the owner for a street it
 * would then offer him as new.
 */

/** Matched against the familiarity corridor: 10 m certain, 16 m still the same road. */
export const STREET_MATCH_RADIUS_METERS = 16;

/**
 * How close a sample has to fall to a struck-off stretch to be swallowed by it.
 *
 * Wider than the familiarity match: an excluded stretch is remembered as the
 * points `describeStreetCoverage` handed back at the moment it was struck off,
 * which is already a walk of *this* street's own geometry — so the two should
 * line up almost exactly, and the margin exists only for the rounding a trip
 * through Firestore's five-decimal wire format introduces.
 */
export const EXCLUDED_SEGMENT_MATCH_RADIUS_METERS = 10;

/**
 * A street counts as done at 90%, or when what is left is a few paces.
 *
 * Two rules because one number cannot be fair to both ends of the scale. A flat
 * 95% on a 1.5 km street means an unforgiving 75 m; on a 40 m stub it means two
 * metres, which no GPS trace will ever satisfy. And OSM geometry routinely runs
 * past where anybody actually goes — turning circles, junction stubs, the last
 * few metres into a bollarded end. Whichever rule is kinder, wins.
 */
export const STREET_COMPLETE_RATIO = 0.9;
export const STREET_COMPLETE_REMAINDER_METERS = 25;

/** Fine enough that the 25 m remainder rule is decided on real geometry. */
const SAMPLE_STEP_METERS = 10;

export type StreetCoverage = {
  streetId: string;
  name: string;
  part: number;
  lengthMeters: number;
  coveredMeters: number;
  /** 0..1 of the in-scope length. */
  ratio: number;
  remainingMeters: number;
  complete: boolean;
  /** Struck off this street specifically, and already out of `lengthMeters`. */
  excludedMeters: number;
};

/** A street's struck-off stretches, exactly as they were when the owner cut them. */
export type SegmentExclusionsByStreet = Map<string, LatLng[][]>;

function isOnExcludedGround(point: LatLng, pieces: LatLng[][] | undefined): boolean {
  if (!pieces || pieces.length === 0) return false;
  for (const piece of pieces) {
    for (let i = 1; i < piece.length; i += 1) {
      if (pointToSegmentDistanceMeters(point, piece[i - 1], piece[i]) <= EXCLUDED_SEGMENT_MATCH_RADIUS_METERS) {
        return true;
      }
    }
  }
  return false;
}

export type ProjectCoverage = {
  streets: StreetCoverage[];
  streetsTotal: number;
  streetsComplete: number;
  totalMeters: number;
  coveredMeters: number;
  /** The headline: streets done over streets in scope. */
  ratio: number;
  /** The consolation prize on a long street: metres done over metres in scope. */
  distanceRatio: number;
};

/**
 * The orders a street list can be read in.
 *
 * `progress` is the default because it answers the question he actually asks
 * the list: which streets am I nearly done with, so I can go and close them
 * out. `remaining` is the older ordering, kept because "what can I finish in
 * the next twenty minutes" is a different question from "what is nearly
 * done" — a 2 km road at 90% still has 200 m left in it, and a 60 m stub at
 * 10% is a two-minute detour.
 */
export type StreetSort = "progress" | "remaining" | "name";

function byName(a: StreetCoverage, b: StreetCoverage): number {
  return a.name.localeCompare(b.name, "sv-SE") || a.part - b.part;
}

/**
 * A street list in the order the runner wants to act on it.
 *
 * Completed streets always sink to the bottom, whatever the sort. They are the
 * ones with nothing left to do, so a town where most streets are done would
 * otherwise open on a wall of green and bury the one street sitting at 94%
 * — which is the only line on the page worth a pair of shoes.
 */
export function sortStreetCoverage(streets: StreetCoverage[], sort: StreetSort = "progress"): StreetCoverage[] {
  const compare = (a: StreetCoverage, b: StreetCoverage): number => {
    if (a.complete !== b.complete) return a.complete ? 1 : -1;
    if (a.complete) return byName(a, b);

    if (sort === "name") return byName(a, b);
    if (sort === "remaining") return a.remainingMeters - b.remainingMeters || byName(a, b);
    // Ties at 0% are common on a fresh project, and a short street is the more
    // actionable of two equally untouched ones.
    return b.ratio - a.ratio || a.remainingMeters - b.remainingMeters || byName(a, b);
  };

  return [...streets].sort(compare);
}

export function isStreetComplete(lengthMeters: number, coveredMeters: number): boolean {
  if (lengthMeters <= 0) return false;
  if (coveredMeters / lengthMeters >= STREET_COMPLETE_RATIO) return true;
  return lengthMeters - coveredMeters <= STREET_COMPLETE_REMAINDER_METERS;
}

/**
 * One street walked end to end, cut wherever the answer to "have I been down
 * here?" changes.
 *
 * Every number and every colour this file produces comes from this one walk.
 * The percentage in the list, the metres still to run, and the green and red
 * drawn on the map are then arithmetic on the same runs rather than three
 * traversals that agree by luck — the failure mode being a street labelled
 * complete with a long red stretch drawn down the middle of it.
 */
type RunState = "covered" | "missing" | "excluded";

type CoverageRun = {
  points: LatLng[];
  state: RunState;
  meters: number;
};

function walkStreet(street: Street, index: FamiliarityIndex, excludedPieces?: LatLng[][]): CoverageRun[] {
  const runs: CoverageRun[] = [];

  for (const piece of street.geometry) {
    const samples = densifyPolyline(piece, SAMPLE_STEP_METERS);
    let current: CoverageRun | null = null;

    for (let i = 1; i < samples.length; i += 1) {
      const from = samples[i - 1];
      const to = samples[i];
      const stepMeters = haversineMeters(from, to);
      if (stepMeters <= 0) continue;

      const mid = midpoint(from, to);
      // Struck off takes priority over the familiarity read: a stretch the
      // owner has ruled out is not "missing" just because he has never run it,
      // and the whole point of striking it off is that it stops asking.
      const state: RunState = isOnExcludedGround(mid, excludedPieces)
        ? "excluded"
        : isOnRunGround(mid, index)
          ? "covered"
          : "missing";

      if (!current) {
        current = { points: [from, to], state, meters: stepMeters };
        continue;
      }

      if (state === current.state) {
        current.points.push(to);
        current.meters += stepMeters;
        continue;
      }

      runs.push(current);
      current = { points: [from, to], state, meters: stepMeters };
    }

    // Pieces are never welded together: a street split by the scope edge is two
    // lines on the map, and joining them would draw across the gap.
    if (current) runs.push(current);
  }

  return runs;
}

export function computeStreetCoverage(
  street: Street,
  index: FamiliarityIndex,
  excludedPieces?: LatLng[][],
): StreetCoverage {
  const runs = walkStreet(street, index, excludedPieces);
  let covered = 0;
  let excluded = 0;
  let length = 0;

  for (const run of runs) {
    if (run.state === "excluded") {
      excluded += run.meters;
      continue;
    }
    length += run.meters;
    if (run.state === "covered") covered += run.meters;
  }

  // Measured length rather than the stored one, so ratio and remainder are
  // answers to the same question and can never disagree at the boundary.
  // The struck-off stretch is never part of it: it shrinks the denominator the
  // same way a whole excluded street does, just at the scale of one stretch.
  const lengthMeters = length > 0 ? length : Math.max(0, street.lengthMeters - excluded);
  const coveredMeters = Math.min(covered, lengthMeters);

  // Nothing left uncounted is done, not stuck. isStreetComplete(0, 0) reads
  // false because a street with no measurable length at all is usually a
  // broken snapshot — but a street with no length left *because every metre
  // of it was struck off* is the opposite of broken: it is the one case where
  // the owner has already said the whole thing is settled.
  const complete = lengthMeters <= 0 && excluded > 0 ? true : isStreetComplete(lengthMeters, coveredMeters);

  return {
    streetId: street.id,
    name: street.name,
    part: street.part,
    lengthMeters,
    coveredMeters,
    ratio: lengthMeters > 0 ? coveredMeters / lengthMeters : 0,
    remainingMeters: Math.max(0, lengthMeters - coveredMeters),
    complete,
    excludedMeters: excluded,
  };
}

export function computeProjectCoverage(
  streets: Street[],
  index: FamiliarityIndex,
  excludedSegments?: SegmentExclusionsByStreet,
): ProjectCoverage {
  const covered = streets.map((street) => computeStreetCoverage(street, index, excludedSegments?.get(street.id)));

  const totalMeters = covered.reduce((sum, street) => sum + street.lengthMeters, 0);
  const coveredMeters = covered.reduce((sum, street) => sum + street.coveredMeters, 0);
  const streetsComplete = covered.filter((street) => street.complete).length;

  return {
    streets: covered,
    streetsTotal: covered.length,
    streetsComplete,
    totalMeters,
    coveredMeters,
    ratio: covered.length > 0 ? streetsComplete / covered.length : 0,
    distanceRatio: totalMeters > 0 ? coveredMeters / totalMeters : 0,
  };
}

/**
 * The street drawn as what is done and what is left, for the map.
 *
 * The same walk as the numbers above, kept in one place so the line the owner
 * sees on the map is the line the percentage was computed from.
 */
export function splitStreetByCoverage(
  street: Street,
  index: FamiliarityIndex,
  excludedPieces?: LatLng[][],
): { covered: LatLng[][]; missing: LatLng[][] } {
  const runs = walkStreet(street, index, excludedPieces);
  return {
    covered: runs.filter((run) => run.state === "covered").map((run) => run.points),
    missing: runs.filter((run) => run.state === "missing").map((run) => run.points),
  };
}

/**
 * Which part of this street is missing, and how much of it.
 *
 * The question the owner actually asks of a street he is 123 m short on: not
 * *how much* is left, which the list already tells him, but *which* 123 m — so
 * he can see whether it is the far end, the middle, or a stub he has run past
 * fifty times without turning into.
 *
 * A finished street reports nothing missing, deliberately. The completion rule
 * is generous on purpose — 90% of a long street, or a remainder small enough to
 * be turning circle rather than road — and a street the app has already
 * congratulated him for must not then be drawn with a red stretch down it
 * arguing the opposite. Once a street is done, the forgiven metres are done
 * too, and this is the one place that decision is made.
 */
export type StreetCoverageSplit = {
  covered: LatLng[][];
  missing: LatLng[][];
  /** Struck off this street specifically, drawn the same muted way a whole excluded street is. */
  excluded: LatLng[][];
  coveredMeters: number;
  missingMeters: number;
  lengthMeters: number;
  complete: boolean;
};

export function describeStreetCoverage(
  street: Street,
  index: FamiliarityIndex,
  excludedPieces?: LatLng[][],
): StreetCoverageSplit {
  const runs = walkStreet(street, index, excludedPieces);
  const excludedLines = runs.filter((run) => run.state === "excluded").map((run) => run.points);

  let coveredMeters = 0;
  let lengthMeters = 0;
  for (const run of runs) {
    if (run.state === "excluded") continue;
    lengthMeters += run.meters;
    if (run.state === "covered") coveredMeters += run.meters;
  }
  if (lengthMeters <= 0 && excludedLines.length === 0) lengthMeters = street.lengthMeters;

  // Same rule as computeStreetCoverage: nothing left uncounted because it was
  // all struck off reads as done, not as a street stuck below 100% forever.
  const complete =
    lengthMeters <= 0 && excludedLines.length > 0
      ? true
      : isStreetComplete(lengthMeters, Math.min(coveredMeters, lengthMeters));

  if (complete) {
    return {
      covered: runs.filter((run) => run.state !== "excluded").map((run) => run.points),
      missing: [],
      excluded: excludedLines,
      coveredMeters: lengthMeters,
      missingMeters: 0,
      lengthMeters,
      complete,
    };
  }

  return {
    covered: runs.filter((run) => run.state === "covered").map((run) => run.points),
    missing: runs.filter((run) => run.state === "missing").map((run) => run.points),
    excluded: excludedLines,
    coveredMeters,
    missingMeters: Math.max(0, lengthMeters - coveredMeters),
    lengthMeters,
    complete,
  };
}

function isOnRunGround(point: LatLng, index: FamiliarityIndex): boolean {
  return nearestFamiliarDistanceMeters(point, index) <= STREET_MATCH_RADIUS_METERS;
}
