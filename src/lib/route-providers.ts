// Route generation providers
// Option 1: Client-side using uploaded routes (graph + loop algorithm)
// Option 2: Mapbox Directions API (circular waypoint routing)

import { GPXRoute } from "@/app/types";
import { haversine } from "@/lib/utils";

// ─── Type definitions ─────────────────────────────────────────────────────────

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

/**
 * Generate a loop by stitching segments from uploaded GPX routes.
 * Algorithm:
 * 1. Find all coordinates within radius of start point
 * 2. Build a graph of nearby trail/road segments
 * 3. Nearest-neighbor path building that forms a loop, respecting target distance
 */
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
  const searchRadiusKm = Math.max(targetDistanceKm * 0.8, 2);

  // Collect all coordinates from uploaded routes, filter by type and proximity
  interface Pt { lon: number; lat: number; }
  const allPts: Pt[] = [];

  for (const route of routes) {
    if (routeType !== "mixed" && route.type && route.type !== routeType && route.type !== "mixed") continue;
    for (const [rlon, rlat] of route.coordinates) {
      const d = haversine(rlat, rlon, startLat, startLon) / 1000;
      if (d <= searchRadiusKm) allPts.push({ lon: rlon, lat: rlat });
    }
  }

  if (allPts.length < 4) {
    return generateFallbackLoop(startPoint, targetDistanceKm, routeType, "my-routes");
  }

  // Sample points to keep computation manageable (max 200)
  const step = Math.max(1, Math.floor(allPts.length / 150));
  const pts = allPts.filter((_, i) => i % step === 0);

  // Cluster into a grid (~80m resolution) to create graph nodes
  const gridSize = 0.00072; // ~80m in degrees
  const grid = new Map<string, Pt[]>();
  for (const p of pts) {
    const gx = Math.round(p.lon / gridSize) * gridSize;
    const gy = Math.round(p.lat / gridSize) * gridSize;
    const key = `${gx.toFixed(5)},${gy.toFixed(5)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key)!.push(p);
  }

  // Each grid cell = one node; use cell center as representative point
  const nodes: Pt[] = Array.from(grid.values()).map(cell => ({
    lon: cell[0].lon,
    lat: cell[0].lat,
  }));

  // Build adjacency: connect nodes within ~250m of each other
  type AdjEntry = { nodeIdx: number; dist: number };
  const edges: Map<number, AdjEntry[]> = new Map();
  nodes.forEach((_, i) => edges.set(i, []));

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const d = haversine(nodes[i].lat, nodes[i].lon, nodes[j].lat, nodes[j].lon);
      if (d < 0.25) {
        edges.get(i)!.push({ nodeIdx: j, dist: d });
        edges.get(j)!.push({ nodeIdx: i, dist: d });
      }
    }
  }

  // Find start node (closest to startPoint)
  let startIdx = 0;
  let minD = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const d = haversine(nodes[i].lat, nodes[i].lon, startLat, startLon);
    if (d < minD) { minD = d; startIdx = i; }
  }

  // Nearest-neighbor loop: always go to closest unvisited node,
  // but stop when we've accumulated enough distance (with buffer for return leg)
  const visited = new Set<number>();
  const path: number[] = [startIdx];
  visited.add(startIdx);
  let totalDistM = 0;
  let current = startIdx;

  while (true) {
    if (signal?.aborted) throw new Error("Aborted");
    const adj = edges.get(current)!;
    const unvisited = adj.filter(e => !visited.has(e.nodeIdx));
    if (unvisited.length === 0) break;

    // Pick nearest unvisited node
    unvisited.sort((a, b) => a.dist - b.dist);
    const next = unvisited[0];

    // Estimate distance if we go to next AND return home
    const distHome = haversine(nodes[next.nodeIdx].lat, nodes[next.nodeIdx].lon, startLat, startLon);
    const projectedTotal = totalDistM + next.dist + distHome;

    // If we have enough distance and going further would overshoot, break and go home
    if (totalDistM >= targetM * 0.65 && projectedTotal >= targetM * 0.9) {
      break;
    }

    visited.add(next.nodeIdx);
    path.push(next.nodeIdx);
    totalDistM += next.dist;
    current = next.nodeIdx;

    if (totalDistM > targetM * 1.2) break;
  }

  // Close the loop back to start
  const returnDist = haversine(nodes[current].lat, nodes[current].lon, startLat, startLon);
  totalDistM += returnDist;

  // Convert path to coordinates
  let coords: [number, number][] = path.map(i => [nodes[i].lon, nodes[i].lat]);

  // Resample each segment for accurate distance
  const resampled: [number, number][] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const d = haversine(coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0]);
    const n = Math.max(2, Math.round(d / 15));
    for (let j = 0; j <= n; j++) {
      const f = j / n;
      resampled.push([
        coords[i][0] + f * (coords[i + 1][0] - coords[i][0]),
        coords[i][1] + f * (coords[i + 1][1] - coords[i][1]),
      ]);
    }
  }
  // Ensure last point is exactly start
  resampled[resampled.length - 1] = [startLon, startLat];

  // Recalculate actual distance
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
    source: "my-routes",
  };
}

// ─── Provider 2: Mapbox Directions API ────────────────────────────────────────

/**
 * Generate a proper circular loop using Mapbox.
 * Strategy: place waypoints around a circle of given radius,
 * use Mapbox roundtrip to create a proper loop route.
 */
export async function generateFromMapbox(
  startPoint: [number, number],
  targetDistanceKm: number,
  routeType: "road" | "trail" | "mixed" = "mixed",
  apiKey: string,
  signal?: AbortSignal
): Promise<GeneratedRoute> {
  const [lng, lat] = startPoint;

  // Radius of circle so circumference ≈ target distance: C = 2πr → r = target / 2π
  const radiusKm = targetDistanceKm / (2 * Math.PI);
  // Clamp radius to reasonable walking distance
  const clampedRadius = Math.max(0.3, Math.min(radiusKm, 4));

  // Generate 6 waypoints evenly around the circle + start point
  const numWpts = 6;
  const waypointList: string[] = [`${lng.toFixed(6)},${lat.toFixed(6)}`];

  for (let i = 1; i <= numWpts; i++) {
    const angle = (i / numWpts) * 2 * Math.PI;
    const dLat = (clampedRadius / 6371) * (180 / Math.PI);
    const dLon = (clampedRadius / (6371 * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI);
    const wlat = lat + dLat * Math.sin(angle);
    const wlon = lng + dLon * Math.cos(angle);
    waypointList.push(`${wlon.toFixed(6)},${wlat.toFixed(6)}`);
  }

  // Close back to start (creates a proper loop)
  waypointList.push(`${lng.toFixed(6)},${lat.toFixed(6)}`);

  const coordStr = waypointList.join(";");
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/walking/${coordStr}` +
    `?geometries=geojson&overview=full&roundtrip=true&access_token=${apiKey}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    if (signal?.aborted) throw new Error("Aborted");
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`Mapbox error: ${res.status}`);

    const data = await res.json();
    if (!data.routes || data.routes.length === 0) {
      throw new Error("No route from Mapbox");
    }

    // Use the longest route (most circular option)
    const route = data.routes.sort((a: any, b: any) => b.distance - a.distance)[0];
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
      source: "mapbox",
    };
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error("Mapbox timeout");
    throw err;
  }
}

// ─── Fallback: Simple pseudo-random loop ─────────────────────────────────────

function generateFallbackLoop(
  startPoint: [number, number],
  targetDistanceKm: number,
  routeType: "road" | "trail" | "mixed",
  source: "my-routes" | "mapbox"
): GeneratedRoute {
  const [startLon, startLat] = startPoint;

  const numPts = routeType === "road" ? 6 : routeType === "trail" ? 14 : 9;
  const radiusKm = targetDistanceKm * 0.38;

  const coords: [number, number][] = [[startLon, startLat]];
  let cx = startLon, cy = startLat;

  for (let i = 0; i < numPts; i++) {
    const t = i / numPts;
    const biasLon = t < 0.5 ? startLon : startLon + (startLon - cx) * 0.08;
    const biasLat = t < 0.5 ? startLat : startLat + (startLat - cy) * 0.08;
    const r = radiusKm * (0.45 + Math.random() * 0.55);
    const angle = (i / numPts) * 2 * Math.PI + Math.random() * 0.4;
    const dLat = (r / 6371) * (180 / Math.PI);
    const dLon = (r / (6371 * Math.cos((cy * Math.PI) / 180))) * (180 / Math.PI);
    cx = biasLon + dLon * Math.cos(angle);
    cy = biasLat + dLat * Math.sin(angle);
    coords.push([cx, cy]);
  }
  coords.push([startLon, startLat]);

  // Resample for accurate distance
  const resampled: [number, number][] = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const d = haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
    const n = Math.max(2, Math.round(d / 20));
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
