import type { LatLng } from "../../src/types";

/**
 * The real situation that hung the server: a runner in Falkenberg with 75
 * logged runs and 585.7 km of history, all from one house, heavily reusing the
 * same street grid.
 *
 * The reuse is the whole point. It is what produces a *dense* familiar graph —
 * ~2,500 nodes — and a sparse synthetic fixture never exercises that. The
 * bounded history comes to ~19,000 points, matching what his client posts.
 */
export const FALKENBERG_HOME: LatLng = { lat: 56.907, lng: 12.5072 };
export const FALKENBERG_RUNS = 75;
export const FALKENBERG_TOTAL_KM = 585.7;
/** Side of the street grid the synthetic runs are snapped to. */
export const GRID_METERS = 100;

const M_PER_DEG_LAT = 111_320;
const mPerDegLng = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

export function metersToLatLng(offsetX: number, offsetY: number): LatLng {
  return {
    lat: FALKENBERG_HOME.lat + offsetY / M_PER_DEG_LAT,
    lng: FALKENBERG_HOME.lng + offsetX / mPerDegLng(FALKENBERG_HOME.lat),
  };
}

export function latLngToMeters(point: LatLng): { x: number; y: number } {
  return {
    x: (point.lng - FALKENBERG_HOME.lng) * mPerDegLng(FALKENBERG_HOME.lat),
    y: (point.lat - FALKENBERG_HOME.lat) * M_PER_DEG_LAT,
  };
}

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Snap to the street grid so separate runs genuinely share segments. */
function snapToGrid(offsetX: number, offsetY: number): LatLng {
  return metersToLatLng(
    Math.round(offsetX / GRID_METERS) * GRID_METERS,
    Math.round(offsetY / GRID_METERS) * GRID_METERS,
  );
}

function buildRun(seed: number, targetMeters: number): LatLng[] {
  const rand = mulberry32(seed);
  const out: LatLng[] = [];
  let x = 0;
  let y = 0;
  let covered = 0;

  // Out-leg along the grid, then retrace: a normal suburban loop.
  while (covered < targetMeters / 2) {
    if (rand() < 0.5) x += rand() < 0.5 ? GRID_METERS : -GRID_METERS;
    else y += rand() < 0.5 ? GRID_METERS : -GRID_METERS;
    covered += GRID_METERS;

    // Sample every ~10 m along the block, as a watch would.
    const from = out[out.length - 1] ?? snapToGrid(0, 0);
    const to = snapToGrid(x, y);
    for (let s = 1; s <= 10; s += 1) {
      out.push({
        lat: from.lat + ((to.lat - from.lat) * s) / 10,
        lng: from.lng + ((to.lng - from.lng) * s) / 10,
      });
    }
  }

  return [...out, ...out.slice().reverse()];
}

export function buildFalkenbergHistory(): LatLng[][] {
  const perRunMeters = (FALKENBERG_TOTAL_KM * 1000) / FALKENBERG_RUNS;
  const tracks: LatLng[][] = [];
  for (let i = 0; i < FALKENBERG_RUNS; i += 1) tracks.push(buildRun(i * 7919 + 13, perRunMeters));
  return tracks;
}
