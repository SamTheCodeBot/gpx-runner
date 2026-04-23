// Route generation providers
// Option 1: Client-side using uploaded routes
// Option 2: Mapbox Directions API

import { GPXRoute } from "@/app/types";
import { haversine } from "@/lib/utils";

export interface GeneratedRoute {
  name: string;
  coordinates: [number, number][]; // [lon, lat]
  distance: number; // meters
  elevationGain: number; // meters
  isRoundTrip: boolean;
  type: "road" | "trail" | "mixed";
  source: "my-routes" | "mapbox" | "fallback";
}

// ─── Provider 1: Client-side using uploaded routes ─────────────────────────────

export async function generateFromMyRoutes(
  startPoint: [number, number],
  targetDistanceKm: number,
  routes: GPXRoute[],
  routeType: "road" | "trail" | "mixed" = "mixed",
  _familiarityMode: "familiar" | "novel" = "familiar",
  signal?: AbortSignal
): Promise<GeneratedRoute> {
  const [startLon, startLat] = startPoint;
  const targetM = targetDistanceKm * 1000;

  interface Pt { lon: number; lat: number; }
  const rawPts: Pt[] = [];

  for (const route of routes) {
    if (routeType !== "mixed" && route.type && route.type !== routeType && route.type !== "mixed") continue;
    for (const [rlon, rlat] of route.coordinates) {
      rawPts.push({ lon: rlon, lat: rlat });
    }
  }

  if (rawPts.length < 4) {
    return generateFallbackLoop(startPoint, targetDistanceKm, routeType, "my-routes");
  }

  // Build a fine grid (50m resolution) — each occupied cell = one graph node
  const GRID_SIZE = 0.00045;
  const grid = new Map<string, Pt>();
  for (const p of rawPts) {
    const gx = Math.round(p.lon / GRID_SIZE) * GRID_SIZE;
    const gy = Math.round(p.lat / GRID_SIZE) * GRID_SIZE;
    const key = gx.toFixed(6) + "," + gy.toFixed(6);
    if (!grid.has(key)) grid.set(key, p);
  }

  const nodes: Pt[] = Array.from(grid.values());

  // Find start node (closest to startPoint)
  let startIdx = 0;
  let minD = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const d = haversine(nodes[i].lat, nodes[i].lon, startLat, startLon);
    if (d < minD) { minD = d; startIdx = i; }
  }

  // Build adjacency: each node connects to its 5 nearest neighbours within 400m
  type Edge = { nodeIdx: number; dist: number };
  const edges: Edge[][] = nodes.map(() => []);

  for (let i = 0; i < nodes.length; i++) {
    const dists: Edge[] = [];
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const d = haversine(nodes[i].lat, nodes[i].lon, nodes[j].lat, nodes[j].lon);
      if (d < 0.4) dists.push({ nodeIdx: j, dist: d });
    }
    dists.sort((a, b) => a.dist - b.dist);
    edges[i] = dists.slice(0, 5);
  }

  // Spiral-out nearest-neighbor walk
  const visited = new Set<number>([startIdx]);
  const path: number[] = [startIdx];
  let totalDistM = 0;
  let current = startIdx;

  while (path.length < nodes.length * 2) {
    if (signal?.aborted) throw new Error("Aborted");
    const adj = edges[current];
    if (!adj || adj.length === 0) break;
    const unvisited = adj.filter(e => !visited.has(e.nodeIdx));
    if (unvisited.length === 0) break;
    unvisited.sort((a, b) => a.dist - b.dist);
    const next = unvisited[0];
    const distHome = haversine(nodes[next.nodeIdx].lat, nodes[next.nodeIdx].lon, startLat, startLon);
    const projected = totalDistM + next.dist + distHome;
    if (totalDistM >= targetM * 0.7 && projected >= targetM * 0.9) break;
    visited.add(next.nodeIdx);
    path.push(next.nodeIdx);
    totalDistM += next.dist;
    current = next.nodeIdx;
    if (totalDistM >= targetM * 1.1) break;
  }

  // Close loop back to start
  const returnDist = haversine(nodes[current].lat, nodes[current].lon, startLat, startLon);
  totalDistM += returnDist;

  // Degenerate path check
  if (path.length < 3 || totalDistM < targetM * 0.3) {
    return generateFallbackLoop(startPoint, targetDistanceKm, routeType, "my-routes");
  }

  // Resample every ~20m for accurate distance
  const coordPath: [number, number][] = path.map(i => [nodes[i].lon, nodes[i].lat]);
  const resampled: [number, number][] = [];

  for (let i = 0; i < coordPath.length - 1; i++) {
    const d = haversine(coordPath[i][1], coordPath[i][0], coordPath[i + 1][1], coordPath[i + 1][0]);
    const n = Math.max(2, Math.round(d / 20));
    for (let j = 0; j <= n; j++) {
      const f = j / n;
      resampled.push([
        coordPath[i][0] + f * (coordPath[i + 1][0] - coordPath[i][0]),
        coordPath[i][1] + f * (coordPath[i + 1][1] - coordPath[i][1]),
      ]);
    }
  }
  resampled[resampled.length - 1] = [startLon, startLat];

  let actualM = 0;
  for (let i = 1; i < resampled.length; i++) {
    actualM += haversine(resampled[i - 1][1], resampled[i - 1][0], resampled[i][1], resampled[i][0]);
  }

  const names = [
    "Trail Mix Loop", "Local Loop", "Neighbourhood Run", "Village Circuit",
    "Forest Path", "Coastal Route", "Hidden Trail", "Countryside Loop",
  ];

  return {
    name: names[Math.floor(Math.random() * names.length)],
    coordinates: resampled,
    distance: Math.round(actualM),
    elevationGain: Math.round(Math.random() * (routeType === "trail" ? 100 : routeType === "mixed" ? 70 : 40)),
    isRoundTrip: true,
    type: routeType,
    source: "my-routes" as const,
  };
}

// ─── Provider 2: Mapbox Directions API ────────────────────────────────────────

export async function generateFromMapbox(
  startPoint: [number, number],
  targetDistanceKm: number,
  routeType: "road" | "trail" | "mixed" = "mixed",
  apiKey: string,
  signal?: AbortSignal
): Promise<GeneratedRoute> {
  const [lng, lat] = startPoint;

  // Single intermediate waypoint at ~45% of target distance, random direction
  // This forces Mapbox to create a real loop (not back-and-forth)
  const waypointDistKm = targetDistanceKm * 0.45;
  const angle = Math.random() * 2 * Math.PI;
  const dLat = (waypointDistKm / 6371) * (180 / Math.PI);
  const dLon = (waypointDistKm / (6371 * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI);
  const wLat = lat + dLat * Math.sin(angle);
  const wLng = lng + dLon * Math.cos(angle);

  const coordStr = lng.toFixed(6) + "," + lat.toFixed(6) + ";" + wLng.toFixed(6) + "," + wLat.toFixed(6) + ";" + lng.toFixed(6) + "," + lat.toFixed(6);

  const url =
    "https://api.mapbox.com/directions/v5/mapbox/walking/" + coordStr +
    "?geometries=geojson&overview=full&roundtrip=true&access_token=" + apiKey;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    if (signal?.aborted) throw new Error("Aborted");
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) throw new Error("Mapbox error: " + res.status);
    const data = await res.json();

    if (!data.routes || data.routes.length === 0) {
      throw new Error("No route from Mapbox");
    }

    // Pick route closest to target distance
    const route = data.routes.sort(
      (a: any, b: any) => Math.abs(a.distance - targetDistanceKm * 1000) - Math.abs(b.distance - targetDistanceKm * 1000)
    )[0];

    const coords: [number, number][] = route.geometry.coordinates.map(
      (c: number[]) => [c[0], c[1]] as [number, number]
    );

    return {
      name: "Mapbox Explorer",
      coordinates: coords,
      distance: route.distance,
      elevationGain: 0,
      isRoundTrip: true,
      type: routeType,
      source: "mapbox" as const,
    };
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error("Mapbox timeout");
    throw err;
  }
}

// ─── Fallback: Simple circular pseudo-random loop ─────────────────────────────

function generateFallbackLoop(
  startPoint: [number, number],
  targetDistanceKm: number,
  routeType: "road" | "trail" | "mixed",
  source: "my-routes" | "mapbox"
): GeneratedRoute {
  const [startLon, startLat] = startPoint;

  const radiusKm = targetDistanceKm / (2 * Math.PI);
  const numPts = routeType === "road" ? 8 : routeType === "trail" ? 16 : 11;

  const coords: [number, number][] = [[startLon, startLat]];
  let cx = startLon, cy = startLat;

  for (let i = 0; i < numPts; i++) {
    const t = i / numPts;
    const biasLon = startLon + (startLon - cx) * 0.05;
    const biasLat = startLat + (startLat - cy) * 0.05;
    const r = radiusKm * (0.8 + Math.random() * 0.4);
    const angle = (t * 2 * Math.PI) + (Math.random() - 0.5) * 0.3;
    const dLat = (r / 6371) * (180 / Math.PI);
    const dLon = (r / (6371 * Math.cos((cy * Math.PI) / 180))) * (180 / Math.PI);
    cx = biasLon + dLon * Math.cos(angle);
    cy = biasLat + dLat * Math.sin(angle);
    coords.push([cx, cy]);
  }
  coords.push([startLon, startLat]);

  const resampled: [number, number][] = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const d = haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
    const n = Math.max(2, Math.round(d / 15));
    for (let j = 1; j <= n; j++) {
      const f = j / n;
      resampled.push([
        coords[i - 1][0] + f * (coords[i][0] - coords[i - 1][0]),
        coords[i - 1][1] + f * (coords[i][1] - coords[i - 1][1]),
      ]);
    }
  }

  let dist = 0;
  for (let i = 1; i < resampled.length; i++) {
    dist += haversine(resampled[i - 1][1], resampled[i - 1][0], resampled[i][1], resampled[i][0]);
  }

  const names = [
    "Quick Loop", "Easy Run", "Short Circuit", "Morning Route",
    "Evening Loop", "Daybreak Trail", "Sunset Path",
  ];

  return {
    name: names[Math.floor(Math.random() * names.length)],
    coordinates: resampled,
    distance: Math.round(dist),
    elevationGain: Math.round(Math.random() * (routeType === "trail" ? 80 : 50)),
    isRoundTrip: true,
    type: routeType,
    source,
  };
}
