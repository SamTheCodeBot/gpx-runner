/**
 * Personal Heatmap utilities
 *
 * Builds a per-segment intensity map from the user's route history.
 * Each route is split into fixed-size cells (use ~50m resolution).
 * Cells with more overlapping routes get higher intensity → rendered as thicker lines.
 */

import { LatLng } from "@/types";

const CELL_SIZE_M = 50; // metres per grid cell

/** Quantize a coordinate to the nearest cell centre (in metres). */
function cellKey(lat: number, lng: number): string {
  const latScale = 111320; // metres per degree latitude
  const lngScale = 111320 * Math.cos((lat * Math.PI) / 180);
  const latCell = Math.round((lat * latScale) / CELL_SIZE_M) * CELL_SIZE_M;
  const lngCell = Math.round((lng * lngScale) / CELL_SIZE_M) * CELL_SIZE_M;
  return `${latCell},${lngCell}`;
}

export interface HeatmapSegment {
  positions: [number, number][]; // polyline for this segment [lon, lat]
  weight: number;               // 2–8, based on run count
  count: number;                // raw overlap count
  color: string;
  opacity: number;
}

const TYPE_COLORS: Record<string, string> = {
  road: "rgb(255 65 164)",
  trail: "rgb(18 221 251)",
  mixed: "rgb(197 45 255)",
};

function baseRouteColor(route: { color?: string; type?: string }): string {
  return route.color || (route.type ? TYPE_COLORS[route.type] : undefined) || TYPE_COLORS.road;
}

function parseRgb(color: string): [number, number, number] | null {
  const rgbMatch = color.match(/rgba?\((\d+)\s*,?\s+(\d+)\s*,?\s+(\d+)/i);
  if (rgbMatch) {
    return [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])];
  }

  const hexMatch = color.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (hexMatch) {
    return [
      parseInt(hexMatch[1], 16),
      parseInt(hexMatch[2], 16),
      parseInt(hexMatch[3], 16),
    ];
  }

  return null;
}

function mixChannel(a: number, b: number, amount: number): number {
  return Math.round(a + (b - a) * amount);
}

function heatColor(baseColor: string, intensity: number): string {
  const rgb = parseRgb(baseColor);
  if (!rgb) return baseColor;

  // Low-frequency segments are pale versions of the route colour; repeated
  // sections move toward the original colour and then a slightly darker shade.
  const lighten = Math.max(0, 0.58 - intensity * 0.5);
  const darken = Math.max(0, intensity - 0.72) * 0.45;
  const lightened = rgb.map((c) => mixChannel(c, 255, lighten));
  const intensified = lightened.map((c) => mixChannel(c, 0, darken));
  return `rgb(${intensified[0]} ${intensified[1]} ${intensified[2]})`;
}

/**
 * Build heatmap segments from a list of routes.
 * Routes typed as 'road'/'trail'/'mixed' can use different heatmap colours.
 */
export function buildPersonalHeatmap(
  routes: { coordinates: [number, number][]; color?: string; type?: string; id: string }[],
  minWeight = 2,
  maxWeight = 8,
): HeatmapSegment[] {
  if (routes.length === 0) return [];

  // 1. Count overlaps per cell across all routes
  const cellCounts = new Map<string, number>();
  for (const route of routes) {
    const seen = new Set<string>();
    for (const [lng, lat] of route.coordinates) {
      const key = cellKey(lat, lng);
      if (!seen.has(key)) {
        seen.add(key);
        cellCounts.set(key, (cellCounts.get(key) ?? 0) + 1);
      }
    }
  }

  // 2. Normalise weights across all routes (max count → maxWeight)
  const maxCount = Math.max(...cellCounts.values(), 1);
  const weightScale = (count: number) => {
    if (maxCount <= 1) return minWeight;
    return Math.round(minWeight + ((count - 1) / (maxCount - 1)) * (maxWeight - minWeight));
  };

  // 3. Build per-route segments with weights
  const segments: HeatmapSegment[] = [];
  for (const route of routes) {
    const seen = new Set<string>();
    const coords = route.coordinates;
    for (let i = 1; i < coords.length; i++) {
      const [lng1, lat1] = coords[i - 1];
      const [lng2, lat2] = coords[i];
      const key = cellKey((lat1 + lat2) / 2, (lng1 + lng2) / 2);
      if (!seen.has(key)) {
        seen.add(key);
        const count = cellCounts.get(key) ?? 1;
        const intensity = maxCount <= 1 ? 0 : (count - 1) / (maxCount - 1);
        segments.push({
          positions: [[lng1, lat1], [lng2, lat2]],
          weight: weightScale(count),
          count,
          color: heatColor(baseRouteColor(route), intensity),
          opacity: 0.4 + intensity * 0.55,
        });
      }
    }
  }

  return segments;
}

/** Simple per-route weight based on how many times this exact route has been run. */
export function routeRunCountWeight(runCount: number): number {
  if (runCount <= 1) return 3;
  if (runCount === 2) return 4;
  if (runCount <= 4) return 5;
  if (runCount <= 8) return 6;
  return Math.min(8, 3 + Math.floor(Math.log2(runCount)));
}
