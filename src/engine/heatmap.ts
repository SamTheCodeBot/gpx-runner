import { LatLng } from "../types";

/**
 * What a personal heatmap is actually for.
 *
 * A global heatmap answers "where do people run". A personal one has a
 * different and more useful question behind it: *where is my rut, and where is
 * my frontier* — which roads do I run over and over without thinking, and
 * which ones have I touched exactly once. One is a habit, the other is an
 * invitation.
 *
 * The version this replaces answered neither. It drew every route as a 7 px
 * screen-space stroke, accumulated the alpha, and normalised the result to the
 * single densest pixel on screen. Three things followed, and all three are the
 * reason the map was unreadable:
 *
 *   1. Thickness carried the data. A metric mapped onto line width makes
 *      neighbouring streets merge into one blob, and a blob has no value you
 *      can read off it.
 *   2. Colour carried the route *type* while brightness carried intensity, so
 *      two unrelated variables shared one visual channel.
 *   3. One loop run fifty times set the maximum, and everything else in the
 *      town collapsed to the bottom of the scale and vanished.
 *
 * So: colour carries the data and nothing else, lines stay thin and constant,
 * the scale is built from the distribution rather than its largest value, and
 * every number on the legend is a real count the runner can verify.
 *
 * Counting happens on the ground, not on the screen. A geographic grid means
 * "you have run this twelve times" stays twelve at every zoom level, which a
 * pixel-accumulating heatmap can never promise.
 */

/**
 * Grid resolution.
 *
 * Fine enough to tell one side of a dual carriageway from the other, coarse
 * enough that GPS drift between two runs down the same road still lands in the
 * same cell. Below about 15 m a runner's own repeats stop matching each other
 * and every run looks new, which is the failure that would make the whole map
 * a lie.
 */
export const DEFAULT_CELL_METERS = 25;

export type HeatmapRun = {
  /** [lon, lat], the shape every route in this app travels in. */
  coordinates: [number, number][];
  /** ISO date. Missing dates still count for frequency, never for recency. */
  date?: string;
};

export type VisitCell = {
  /** Distinct runs through this cell. Not samples, not points: runs. */
  visits: number;
  /** Epoch ms of the most recent run through it, or null when undated. */
  lastRunAt: number | null;
};

export type VisitGrid = {
  cellMeters: number;
  origin: LatLng;
  cells: Map<string, VisitCell>;
  maxVisits: number;
  /** Runs that carried usable geometry, for honest denominators. */
  runCount: number;
};

/**
 * Cell address of a point.
 *
 * A local equirectangular projection about the grid's own origin. Over the few
 * tens of kilometres a person's running history spans, the error against a
 * proper projection is far below one cell; across a hemisphere it would be
 * nonsense, which is why the origin travels with the grid.
 */
export function cellKeyFor(point: LatLng, origin: LatLng, cellMeters: number): string {
  const metersPerDegreeLng = 111_320 * Math.cos((origin.lat * Math.PI) / 180);
  const x = Math.floor(((point.lng - origin.lng) * metersPerDegreeLng) / cellMeters);
  const y = Math.floor(((point.lat - origin.lat) * 111_320) / cellMeters);
  return `${x}:${y}`;
}

/**
 * Walk a run's geometry, touching every cell it passes through.
 *
 * Stepping at half a cell is what stops a fast straight stretch with sparse
 * GPS points from skipping cells between fixes and drawing a dotted line
 * through ground the runner covered continuously.
 */
function* cellsAlong(
  coordinates: [number, number][],
  origin: LatLng,
  cellMeters: number,
): Generator<string> {
  const metersPerDegreeLng = 111_320 * Math.cos((origin.lat * Math.PI) / 180);
  const step = cellMeters / 2;

  for (let i = 1; i < coordinates.length; i += 1) {
    const [fromLng, fromLat] = coordinates[i - 1];
    const [toLng, toLat] = coordinates[i];

    const dx = (toLng - fromLng) * metersPerDegreeLng;
    const dy = (toLat - fromLat) * 111_320;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.max(1, Math.ceil(distance / step));

    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      yield cellKeyFor(
        { lat: fromLat + (toLat - fromLat) * t, lng: fromLng + (toLng - fromLng) * t },
        origin,
        cellMeters,
      );
    }
  }
}

export function buildVisitGrid(runs: HeatmapRun[], cellMeters = DEFAULT_CELL_METERS): VisitGrid {
  const usable = runs.filter((run) => run.coordinates && run.coordinates.length >= 2);
  const origin = usable.length > 0 ? { lat: usable[0].coordinates[0][1], lng: usable[0].coordinates[0][0] } : { lat: 0, lng: 0 };

  const cells = new Map<string, VisitCell>();
  // Which run last touched each cell. Lets one run crossing its own path a
  // hundred times still count as one visit, without a Set per cell.
  const lastRunIndex = new Map<string, number>();
  let maxVisits = 0;

  usable.forEach((run, runIndex) => {
    const runAt = run.date ? Date.parse(run.date) : Number.NaN;
    const stamp = Number.isFinite(runAt) ? runAt : null;

    for (const key of cellsAlong(run.coordinates, origin, cellMeters)) {
      if (lastRunIndex.get(key) === runIndex) continue;
      lastRunIndex.set(key, runIndex);

      const existing = cells.get(key);
      if (!existing) {
        cells.set(key, { visits: 1, lastRunAt: stamp });
        if (maxVisits < 1) maxVisits = 1;
        continue;
      }

      existing.visits += 1;
      if (stamp !== null && (existing.lastRunAt === null || stamp > existing.lastRunAt)) {
        existing.lastRunAt = stamp;
      }
      if (existing.visits > maxVisits) maxVisits = existing.visits;
    }
  });

  return { cellMeters, origin, cells, maxVisits, runCount: usable.length };
}

export function cellAt(grid: VisitGrid, point: LatLng): VisitCell | null {
  return grid.cells.get(cellKeyFor(point, grid.origin, grid.cellMeters)) ?? null;
}

/**
 * The legend, built from the distribution rather than from the maximum.
 *
 * The old scale divided by the busiest pixel, so a single obsessively repeated
 * loop pushed every other road to the bottom of the ramp and out of sight.
 * Quantiles cannot do that: they describe where the runner's ground actually
 * sits, so half the map is always above the midpoint however lopsided the
 * history is.
 *
 * Stops come back as real visit counts, because a legend a runner cannot check
 * against his own memory of a road is decoration.
 */
export function frequencyStops(grid: VisitGrid, bands = 5): number[] {
  if (grid.cells.size === 0) return [];

  const counts = new Array<number>(grid.cells.size);
  let index = 0;
  for (const cell of grid.cells.values()) counts[index++] = cell.visits;
  counts.sort((a, b) => a - b);

  const stops: number[] = [];
  for (let band = 0; band < bands; band += 1) {
    const quantile = band / (bands - 1);
    const at = Math.min(counts.length - 1, Math.floor(quantile * (counts.length - 1)));
    stops.push(counts[at]);
  }

  // A history where nine tenths of the ground was run once produces repeated
  // stops; a legend with "1, 1, 1, 2, 47" on it is worse than a shorter one.
  const unique = [...new Set(stops)].sort((a, b) => a - b);
  if (unique[0] !== 1 && counts[0] === 1) unique.unshift(1);
  if (unique[unique.length - 1] !== grid.maxVisits) unique.push(grid.maxVisits);
  return [...new Set(unique)];
}

/**
 * Where a visit count sits on the scale, 0..1.
 *
 * Interpolated between the legend's own stops, so the colour a stretch of road
 * is drawn in and the number printed beside it on the legend cannot disagree.
 */
export function frequencyPosition(visits: number, stops: number[]): number {
  if (stops.length === 0) return 0;
  if (stops.length === 1) return 0;
  if (visits <= stops[0]) return 0;
  if (visits >= stops[stops.length - 1]) return 1;

  for (let i = 1; i < stops.length; i += 1) {
    if (visits <= stops[i]) {
      const span = stops[i] - stops[i - 1];
      const within = span <= 0 ? 0 : (visits - stops[i - 1]) / span;
      return (i - 1 + within) / (stops.length - 1);
    }
  }

  return 1;
}

/** Days since a cell was last run, or null when nothing there carried a date. */
export function daysSince(cell: VisitCell, now = Date.now()): number | null {
  if (cell.lastRunAt === null) return null;
  return Math.max(0, (now - cell.lastRunAt) / (24 * 60 * 60 * 1000));
}

/**
 * The bands the recency view is drawn in.
 *
 * Months, not a continuous ramp. "Six weeks ago" and "seven weeks ago" are the
 * same fact to a runner; "this month" and "not since last winter" are not.
 */
export const RECENCY_BANDS: Array<{ maxDays: number; label: string }> = [
  { maxDays: 30, label: "This month" },
  { maxDays: 90, label: "3 months" },
  { maxDays: 182, label: "6 months" },
  { maxDays: 365, label: "This year" },
  { maxDays: Number.POSITIVE_INFINITY, label: "Over a year" },
];

export function recencyBandIndex(days: number | null): number {
  if (days === null) return RECENCY_BANDS.length - 1;
  for (let i = 0; i < RECENCY_BANDS.length; i += 1) {
    if (days <= RECENCY_BANDS[i].maxDays) return i;
  }
  return RECENCY_BANDS.length - 1;
}

export type HeatmapSummary = {
  /** Distinct ground covered, in metres. Every cell counted once, ever. */
  uniqueGroundMeters: number;
  /** Share of that ground run exactly once, 0..1. The frontier. */
  onceOnlyRatio: number;
  /** Visits to the most-run ground in the history. */
  maxVisits: number;
  /** Cells at that maximum, so "my one favourite corner" reads as one corner. */
  runCount: number;
};

/**
 * The sentence above the map.
 *
 * Unique ground is the number this whole view exists to produce and the one a
 * total-distance figure can never give: a runner with 1,458 km who has covered
 * 180 km of distinct road has run every metre of it eight times on average,
 * and that is the fact the picture is about to show him.
 */
export function summariseGrid(grid: VisitGrid): HeatmapSummary {
  let onceOnly = 0;
  for (const cell of grid.cells.values()) if (cell.visits === 1) onceOnly += 1;

  return {
    uniqueGroundMeters: grid.cells.size * grid.cellMeters,
    onceOnlyRatio: grid.cells.size === 0 ? 0 : onceOnly / grid.cells.size,
    maxVisits: grid.maxVisits,
    runCount: grid.runCount,
  };
}
