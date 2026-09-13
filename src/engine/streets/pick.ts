import { LatLng } from "../../types";
import { pointToSegmentDistanceMeters } from "../utils/geo";
import {
  addSegmentToGrid,
  cellRadiusForMeters,
  createSegmentGrid,
  nearbyValues,
  type SegmentGrid,
} from "../utils/spatialGrid";
import type { Street } from "./inventory";

/**
 * Which street did he just click?
 *
 * The street list answers "what is left", and the map answers "where is it" —
 * but the thing he actually wants is the pair, which means being able to point
 * at a gap on the map and have the app name it and tick it. That is a nearest
 * neighbour query over every street in a project, several hundred of them and
 * tens of thousands of segments, run on every tap. Against the same grid the
 * familiarity engine uses it is a lookup in a handful of cells.
 *
 * The index is built over whichever streets the caller is drawing. A map
 * showing only unrun streets therefore cannot select a finished one, without
 * the picker needing to know what "finished" means.
 */

const CELL_METERS = 40;

/** A tap is aimed with a fingertip, not a cursor: the caller widens this. */
export const DEFAULT_PICK_TOLERANCE_METERS = 40;

type PickSegment = {
  streetId: string;
  from: LatLng;
  to: LatLng;
};

export type StreetPickIndex = {
  segments: PickSegment[];
  /** Cell contents are indices into `segments`. */
  grid: SegmentGrid<number>;
};

export type StreetPick = {
  streetId: string;
  /** How far the click actually landed from the street, for the caller to judge. */
  distanceMeters: number;
};

export function buildStreetPickIndex(streets: Street[]): StreetPickIndex {
  const first = streets.find((street) => street.geometry.some((piece) => piece.length > 0));
  const reference = first?.geometry.find((piece) => piece.length > 0)?.[0];

  const segments: PickSegment[] = [];
  const grid = createSegmentGrid<number>(CELL_METERS, reference);

  for (const street of streets) {
    for (const piece of street.geometry) {
      for (let i = 1; i < piece.length; i += 1) {
        const from = piece[i - 1];
        const to = piece[i];
        addSegmentToGrid(grid, from, to, segments.length);
        segments.push({ streetId: street.id, from, to });
      }
    }
  }

  return { segments, grid };
}

/**
 * The nearest street to a point, or nothing if the click was on open ground.
 *
 * Nearest rather than first: two streets meet at every junction, and the one he
 * meant is the one his finger was closest to. Returning nothing for a click in
 * a field matters as much — it is how the map knows he is deselecting rather
 * than picking whatever happened to be a hundred metres away.
 */
export function pickStreetAt(
  point: LatLng,
  index: StreetPickIndex,
  toleranceMeters: number = DEFAULT_PICK_TOLERANCE_METERS,
): StreetPick | null {
  if (index.segments.length === 0 || toleranceMeters <= 0) return null;

  const candidates = nearbyValues(index.grid, point, cellRadiusForMeters(index.grid, toleranceMeters));
  if (candidates.length === 0) return null;

  let best: StreetPick | null = null;

  for (const candidate of candidates) {
    const segment = index.segments[candidate];
    if (best && segment.streetId === best.streetId && best.distanceMeters <= 1) continue;

    const distance = pointToSegmentDistanceMeters(point, segment.from, segment.to);
    if (distance > toleranceMeters) continue;
    if (best && distance >= best.distanceMeters) continue;

    best = { streetId: segment.streetId, distanceMeters: distance };
  }

  return best;
}
