import "./helpers/alias";

import { buildFamiliarityIndex } from "@/engine/familiarity";
import { buildFamiliarGraph, findGraphLoops } from "@/engine/familiarityGraph";
import { boundTracksNearStart, historyRadiusMeters } from "@/engine/trackHistory";
import type { LatLng } from "@/types";

/**
 * Reproduces Magnus's real situation: 75 runs, ~585 km total, all starting from
 * one house, heavily reusing the same street grid. That reuse is the point —
 * it produces a dense familiar graph, which is what a sparse synthetic fixture
 * never exercises.
 */
const HOME: LatLng = { lat: 56.907, lng: 12.5072 };
const TOTAL_KM = 585.7;
const RUNS = 75;

const M_PER_DEG_LAT = 111_320;
const mPerDegLng = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Snap to a 100 m street grid so separate runs genuinely share segments. */
function snapToGrid(offsetX: number, offsetY: number): LatLng {
  const gx = Math.round(offsetX / 100) * 100;
  const gy = Math.round(offsetY / 100) * 100;
  return { lat: HOME.lat + gy / M_PER_DEG_LAT, lng: HOME.lng + gx / mPerDegLng(HOME.lat) };
}

function buildRun(seed: number, targetMeters: number): LatLng[] {
  const rand = mulberry32(seed);
  const out: LatLng[] = [];
  let x = 0;
  let y = 0;
  let covered = 0;

  // Out-leg along the grid, then retrace: a normal suburban loop.
  while (covered < targetMeters / 2) {
    if (rand() < 0.5) x += rand() < 0.5 ? 100 : -100;
    else y += rand() < 0.5 ? 100 : -100;
    covered += 100;
    // sample every ~10 m along the block
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

const perRunMeters = (TOTAL_KM * 1000) / RUNS;
const tracks: LatLng[][] = [];
for (let i = 0; i < RUNS; i += 1) tracks.push(buildRun(i * 7919 + 13, perRunMeters));

const totalPoints = tracks.reduce((s, t) => s + t.length, 0);
console.log(`synthetic history: ${tracks.length} runs, ${totalPoints} points`);

const targetMeters = 5000;

function time<T>(label: string, fn: () => T): T {
  const started = Date.now();
  const result = fn();
  console.log(`${label}: ${Date.now() - started} ms`);
  return result;
}

const radius = historyRadiusMeters(targetMeters / 1000);
const bounded = time("boundTracksNearStart", () => boundTracksNearStart(tracks, HOME, { radiusMeters: radius }));
console.log(`  bounded to ${bounded.length} tracks, ${bounded.reduce((s, t) => s + t.length, 0)} points`);

time("buildFamiliarityIndex", () => buildFamiliarityIndex(bounded));
const graph = time("buildFamiliarGraph", () => buildFamiliarGraph(bounded, HOME));
console.log(`  graph nodes: ${graph.nodes.size}, startNodeId: ${graph.startNodeId}`);

console.log("calling findGraphLoops (this is the suspect)...");
const loops = time("findGraphLoops", () => findGraphLoops(graph, targetMeters, 500, 24));
console.log(`  loops found: ${loops.length}`);
console.log("COMPLETED WITHOUT HANGING");
