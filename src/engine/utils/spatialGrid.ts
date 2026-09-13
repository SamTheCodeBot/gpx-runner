import { LatLng } from "../../types";
import { haversineMeters } from "./geo";

/**
 * A uniform grid over line segments, so "what is near this point?" is a lookup
 * rather than a scan.
 *
 * Written once and used twice, because the two questions this app asks of a
 * town are the same question pointed in opposite directions. The familiarity
 * engine asks "is this ground I have run?" against every logged track; the
 * street picker asks "which street did he just click?" against every street in
 * the project. Both are tens of thousands of segments around one town, both are
 * quadratic if answered honestly, and both are instant against a grid.
 *
 * Cells are sized in metres and laid out in degrees, which is a lie that only
 * matters near the poles. The longitude step is computed once from a reference
 * latitude rather than per point: within one town the error is a fraction of a
 * cell, and a grid whose geometry shifted as you walked across it could not be
 * indexed at all.
 */

export type SegmentGrid<T> = {
  cellMeters: number;
  latStep: number;
  lngStep: number;
  cells: Map<string, T[]>;
};

export function createSegmentGrid<T>(cellMeters: number, reference?: LatLng): SegmentGrid<T> {
  const latStep = cellMeters / 111_320;
  const cosLat = Math.cos(((reference?.lat ?? 0) * Math.PI) / 180);
  const lngStep = cellMeters / Math.max(1, 111_320 * Math.max(0.05, Math.abs(cosLat)));
  return { cellMeters, latStep, lngStep, cells: new Map() };
}

function cellKey<T>(grid: SegmentGrid<T>, point: LatLng): string {
  return `${Math.floor(point.lat / grid.latStep)}:${Math.floor(point.lng / grid.lngStep)}`;
}

/**
 * Files one segment under every cell it passes through.
 *
 * Sampled at half a cell, so a segment that cuts a corner is never filed only
 * under the cells containing its two ends — the cell it crosses in the middle
 * is exactly where somebody will click.
 */
export function addSegmentToGrid<T>(grid: SegmentGrid<T>, from: LatLng, to: LatLng, value: T): void {
  const steps = Math.max(1, Math.ceil(haversineMeters(from, to) / (grid.cellMeters / 2)));
  const keys = new Set<string>();

  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    keys.add(
      cellKey(grid, {
        lat: from.lat + (to.lat - from.lat) * t,
        lng: from.lng + (to.lng - from.lng) * t,
      }),
    );
  }

  for (const key of keys) {
    const bucket = grid.cells.get(key);
    if (bucket) bucket.push(value);
    else grid.cells.set(key, [value]);
  }
}

/**
 * Everything filed in the cells around a point.
 *
 * `cellRadius` rings out from the point's own cell: one ring guarantees any
 * segment within a cell's width, which is why callers matching inside a
 * corridor narrower than the cell can stop at the default. A caller with a
 * wider tolerance — a fat-fingered tap on a zoomed-out map — must ring out far
 * enough to cover it, or it will confidently miss the road it is standing on.
 */
export function nearbyValues<T>(grid: SegmentGrid<T>, point: LatLng, cellRadius = 1): T[] {
  const latCell = Math.floor(point.lat / grid.latStep);
  const lngCell = Math.floor(point.lng / grid.lngStep);
  const found: T[] = [];

  for (let dLat = -cellRadius; dLat <= cellRadius; dLat += 1) {
    for (let dLng = -cellRadius; dLng <= cellRadius; dLng += 1) {
      const bucket = grid.cells.get(`${latCell + dLat}:${lngCell + dLng}`);
      if (bucket) found.push(...bucket);
    }
  }

  return found;
}

/** Rings needed to be sure nothing within `meters` of the point is missed. */
export function cellRadiusForMeters<T>(grid: SegmentGrid<T>, meters: number): number {
  return Math.max(1, Math.ceil(meters / grid.cellMeters));
}
