import { LatLng } from "../../types";
import { nearestFamiliarDistanceMeters, type FamiliarityIndex } from "../familiarity";
import { densifyPolyline, haversineMeters } from "../utils/geo";
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
};

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

export function isStreetComplete(lengthMeters: number, coveredMeters: number): boolean {
  if (lengthMeters <= 0) return false;
  if (coveredMeters / lengthMeters >= STREET_COMPLETE_RATIO) return true;
  return lengthMeters - coveredMeters <= STREET_COMPLETE_REMAINDER_METERS;
}

export function computeStreetCoverage(street: Street, index: FamiliarityIndex): StreetCoverage {
  let covered = 0;
  let length = 0;

  for (const piece of street.geometry) {
    const samples = densifyPolyline(piece, SAMPLE_STEP_METERS);

    for (let i = 1; i < samples.length; i += 1) {
      const from = samples[i - 1];
      const to = samples[i];
      const stepMeters = haversineMeters(from, to);
      if (stepMeters <= 0) continue;

      length += stepMeters;
      const midpoint = { lat: (from.lat + to.lat) / 2, lng: (from.lng + to.lng) / 2 };
      if (isOnRunGround(midpoint, index)) covered += stepMeters;
    }
  }

  // Measured length rather than the stored one, so ratio and remainder are
  // answers to the same question and can never disagree at the boundary.
  const lengthMeters = length > 0 ? length : street.lengthMeters;
  const coveredMeters = Math.min(covered, lengthMeters);

  return {
    streetId: street.id,
    name: street.name,
    part: street.part,
    lengthMeters,
    coveredMeters,
    ratio: lengthMeters > 0 ? coveredMeters / lengthMeters : 0,
    remainingMeters: Math.max(0, lengthMeters - coveredMeters),
    complete: isStreetComplete(lengthMeters, coveredMeters),
  };
}

export function computeProjectCoverage(streets: Street[], index: FamiliarityIndex): ProjectCoverage {
  const covered = streets.map((street) => computeStreetCoverage(street, index));

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
 * The same sampling as the numbers above, kept in one place so the line the
 * owner sees on the map is the line the percentage was computed from.
 */
export function splitStreetByCoverage(
  street: Street,
  index: FamiliarityIndex,
): { covered: LatLng[][]; missing: LatLng[][] } {
  const covered: LatLng[][] = [];
  const missing: LatLng[][] = [];

  for (const piece of street.geometry) {
    const samples = densifyPolyline(piece, SAMPLE_STEP_METERS);
    let current: LatLng[] = [];
    let currentCovered: boolean | null = null;

    for (let i = 1; i < samples.length; i += 1) {
      const from = samples[i - 1];
      const to = samples[i];
      const midpoint = { lat: (from.lat + to.lat) / 2, lng: (from.lng + to.lng) / 2 };
      const isCovered = isOnRunGround(midpoint, index);

      if (currentCovered === null) {
        current = [from, to];
        currentCovered = isCovered;
        continue;
      }

      if (isCovered === currentCovered) {
        current.push(to);
        continue;
      }

      (currentCovered ? covered : missing).push(current);
      current = [from, to];
      currentCovered = isCovered;
    }

    if (currentCovered !== null && current.length >= 2) {
      (currentCovered ? covered : missing).push(current);
    }
  }

  return { covered, missing };
}

function isOnRunGround(point: LatLng, index: FamiliarityIndex): boolean {
  return nearestFamiliarDistanceMeters(point, index) <= STREET_MATCH_RADIUS_METERS;
}
