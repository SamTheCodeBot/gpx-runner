/**
 * Personal heatmap utilities.
 *
 * The overlay is drawn from the full uploaded route geometry. Frequency is
 * measured with small sampled cells, but rendering keeps continuous polyline
 * coverage so the heatmap does not collapse into dots or short dashes.
 */

const CELL_SIZE_M = 22;
const SAMPLE_STEP_M = 10;
const RENDER_STEP_M = 18;

type RouteForHeatmap = {
  coordinates: [number, number][];
  color?: string;
  type?: string;
  id: string;
};

export interface HeatmapSegment {
  positions: [number, number][]; // [lon, lat]
  weight: number;
  count: number;
  color: string;
  opacity: number;
}

const TYPE_COLORS: Record<string, string> = {
  road: "rgb(255 65 164)",
  trail: "rgb(18 221 251)",
  mixed: "rgb(197 45 255)",
};

const TYPE_HEAT_RAMPS: Record<string, [[number, number, number], [number, number, number], [number, number, number]]> = {
  road: [
    [255, 185, 215],
    [255, 65, 164],
    [242, 4, 132],
  ],
  trail: [
    [188, 248, 255],
    [18, 221, 251],
    [0, 150, 204],
  ],
  mixed: [
    [231, 190, 255],
    [197, 45, 255],
    [132, 0, 208],
  ],
};

function baseRouteColor(route: { color?: string; type?: string }): string {
  return route.color || (route.type ? TYPE_COLORS[route.type] : undefined) || TYPE_COLORS.road;
}

function haversineMeters(a: [number, number], b: [number, number]): number {
  const radius = 6371000;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function interpolate(a: [number, number], b: [number, number], fraction: number): [number, number] {
  return [
    a[0] + (b[0] - a[0]) * fraction,
    a[1] + (b[1] - a[1]) * fraction,
  ];
}

function cellKey([lng, lat]: [number, number]): string {
  const latScale = 111320;
  const lngScale = Math.max(1, 111320 * Math.cos((lat * Math.PI) / 180));
  const latCell = Math.round((lat * latScale) / CELL_SIZE_M);
  const lngCell = Math.round((lng * lngScale) / CELL_SIZE_M);
  return `${latCell},${lngCell}`;
}

function sampledCellsForSegment(a: [number, number], b: [number, number], stepMeters: number): string[] {
  const distance = haversineMeters(a, b);
  const steps = Math.max(1, Math.ceil(distance / stepMeters));
  const cells: string[] = [];

  for (let i = 0; i <= steps; i += 1) {
    cells.push(cellKey(interpolate(a, b, i / steps)));
  }

  return cells;
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

function interpolateRgb(
  from: [number, number, number],
  to: [number, number, number],
  amount: number,
): [number, number, number] {
  return [
    mixChannel(from[0], to[0], amount),
    mixChannel(from[1], to[1], amount),
    mixChannel(from[2], to[2], amount),
  ];
}

function heatColor(route: { color?: string; type?: string }, intensity: number): string {
  const ramp = route.type ? TYPE_HEAT_RAMPS[route.type] : undefined;
  if (ramp) {
    const [low, base, high] = ramp;
    const rgb = intensity <= 0.55
      ? interpolateRgb(low, base, intensity / 0.55)
      : interpolateRgb(base, high, (intensity - 0.55) / 0.45);
    return `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})`;
  }

  const baseColor = baseRouteColor(route);
  const rgb = parseRgb(baseColor);
  if (!rgb) return baseColor;

  const lighten = Math.max(0, 0.38 - intensity * 0.34);
  const darken = Math.max(0, intensity - 0.68) * 0.5;
  const lightened = rgb.map((c) => mixChannel(c, 255, lighten));
  const intensified = lightened.map((c) => mixChannel(c, 0, darken));
  return `rgb(${intensified[0]} ${intensified[1]} ${intensified[2]})`;
}

function scaleCount(count: number, maxCount: number, min: number, max: number): number {
  if (maxCount <= 1) return min;
  const intensity = (count - 1) / (maxCount - 1);
  return min + intensity * (max - min);
}

function countForRenderedChunk(a: [number, number], b: [number, number], cellCounts: Map<string, number>): number {
  const cells = sampledCellsForSegment(a, b, SAMPLE_STEP_M);
  return Math.max(1, ...cells.map((key) => cellCounts.get(key) ?? 1));
}

export function buildPersonalHeatmap(
  routes: RouteForHeatmap[],
  minWeight = 2.5,
  maxWeight = 9.5,
): HeatmapSegment[] {
  if (routes.length === 0) return [];

  const cellCounts = new Map<string, number>();

  for (const route of routes) {
    const routeCells = new Set<string>();
    const coords = route.coordinates;

    for (let i = 1; i < coords.length; i += 1) {
      for (const key of sampledCellsForSegment(coords[i - 1], coords[i], SAMPLE_STEP_M)) {
        routeCells.add(key);
      }
    }

    for (const key of routeCells) {
      cellCounts.set(key, (cellCounts.get(key) ?? 0) + 1);
    }
  }

  const maxCount = Math.max(1, ...cellCounts.values());
  const segments: HeatmapSegment[] = [];

  for (const route of routes) {
    const coords = route.coordinates;

    for (let i = 1; i < coords.length; i += 1) {
      const from = coords[i - 1];
      const to = coords[i];
      const distance = haversineMeters(from, to);
      if (distance < 0.5) continue;

      const chunks = Math.max(1, Math.ceil(distance / RENDER_STEP_M));
      for (let chunk = 0; chunk < chunks; chunk += 1) {
        const a = interpolate(from, to, chunk / chunks);
        const b = interpolate(from, to, (chunk + 1) / chunks);
        const count = countForRenderedChunk(a, b, cellCounts);
        const intensity = maxCount <= 1 ? 0 : (count - 1) / (maxCount - 1);

        segments.push({
          positions: [a, b],
          weight: scaleCount(count, maxCount, minWeight, maxWeight),
          count,
          color: heatColor(route, intensity),
          opacity: 0.5 + intensity * 0.45,
        });
      }
    }
  }

  return segments;
}

export function routeRunCountWeight(runCount: number): number {
  if (runCount <= 1) return 3;
  if (runCount === 2) return 4;
  if (runCount <= 4) return 5;
  if (runCount <= 8) return 6;
  return Math.min(8, 3 + Math.floor(Math.log2(runCount)));
}
