import type { LatLng } from "../../src/types";
export const FALKENBERG_HOME: LatLng = { lat: 56.907, lng: 12.5072 };
const M_PER_DEG_LAT = 111_320;
const mPerDegLng = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function snapToGrid(offsetX: number, offsetY: number): LatLng {
  const gx = Math.round(offsetX / 100) * 100;
  const gy = Math.round(offsetY / 100) * 100;
  return { lat: FALKENBERG_HOME.lat + gy / M_PER_DEG_LAT, lng: FALKENBERG_HOME.lng + gx / mPerDegLng(FALKENBERG_HOME.lat) };
}
function buildRun(seed: number, targetMeters: number): LatLng[] {
  const rand = mulberry32(seed);
  const out: LatLng[] = [];
  let x = 0, y = 0, covered = 0;
  while (covered < targetMeters / 2) {
    if (rand() < 0.5) x += rand() < 0.5 ? 100 : -100;
    else y += rand() < 0.5 ? 100 : -100;
    covered += 100;
    const from = out[out.length - 1] ?? snapToGrid(0, 0);
    const to = snapToGrid(x, y);
    for (let s = 1; s <= 10; s += 1) {
      out.push({ lat: from.lat + ((to.lat - from.lat) * s) / 10, lng: from.lng + ((to.lng - from.lng) * s) / 10 });
    }
  }
  return [...out, ...out.slice().reverse()];
}
export const FALKENBERG_RUNS = 75;
export const FALKENBERG_TOTAL_KM = 585.7;
export function buildFalkenbergHistory(): LatLng[][] {
  const perRunMeters = (FALKENBERG_TOTAL_KM * 1000) / FALKENBERG_RUNS;
  const tracks: LatLng[][] = [];
  for (let i = 0; i < FALKENBERG_RUNS; i += 1) tracks.push(buildRun(i * 7919 + 13, perRunMeters));
  return tracks;
}
