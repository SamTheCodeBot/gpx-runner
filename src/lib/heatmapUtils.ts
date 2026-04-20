/**
 * Personal Heatmap utilities
 *
 * Builds a per-segment intensity map from the user's route history.
 * Routes run multiple times leave thicker gold lines on the map.
 */

import type { GPXRoute } from "@/app/types";

const CELL_SIZE_M = 50; // metres per grid cell

function cellKey(lat: number, lng: number): string {
  const latScale = 111320;
  const lngScale = 111320 * Math.cos((lat * Math.PI) / 180);
  const latCell = Math.round((lat * latScale) / CELL_SIZE_M) * CELL_SIZE_M;
  const lngCell = Math.round((lng * lngScale) / CELL_SIZE_M) * CELL_SIZE_M;
  return `${latCell},${lngCell}`;
}

export interface HeatmapSegment {
  positions: [number, number][]; // [lon, lat]
  weight: number;               // 2–8, based on run count
  count: number;                // raw overlap count
  color: string;
}

/** Gold — user's personal heatmap signature colour */
export const HEATMAP_COLOR = "rgb(255 215 0)";

/**
 * Build heatmap segments from the user's route history.
 * Cells with more overlapping routes → higher weight → thicker gold lines.
 */
export function buildPersonalHeatmap(
  routes: GPXRoute[],
  minWeight = 2,
  maxWeight = 8,
): HeatmapSegment[] {
  if (routes.length === 0) return [];

  // Count overlaps per cell across all routes
  const cellCounts = new Map<string, number>();
  for (const route of routes) {
    if (!route.coordinates?.length) continue;
    const seen = new Set<string>();
    for (const [lng, lat] of route.coordinates) {
      const key = cellKey(lat, lng);
      if (!seen.has(key)) {
        seen.add(key);
        cellCounts.set(key, (cellCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const maxCount = Math.max(...cellCounts.values(), 1);
  const weightScale = (count: number) =>
    Math.round(minWeight + ((count - 1) / (maxCount - 1)) * (maxWeight - minWeight));

  const segments: HeatmapSegment[] = [];
  for (const route of routes) {
    if (!route.coordinates?.length) continue;
    const seen = new Set<string>();
    const coords = route.coordinates;
    for (let i = 1; i < coords.length; i++) {
      const [lng1, lat1] = coords[i - 1];
      const [lng2, lat2] = coords[i];
      const key = cellKey((lat1 + lat2) / 2, (lng1 + lng2) / 2);
      if (!seen.has(key)) {
        seen.add(key);
        const count = cellCounts.get(key) ?? 1;
        segments.push({
          positions: [[lng1, lat1], [lng2, lat2]],
          weight: weightScale(count),
          count,
          color: HEATMAP_COLOR,
        });
      }
    }
  }

  return segments;
}
