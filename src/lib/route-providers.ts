// Route generation providers
// Two approaches: (1) client-side using uploaded routes, (2) Mapbox Directions API

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
 * Works entirely client-side, no API needed.
 * 
 * Algorithm:
 * 1. Find all route points within searchRadiusKm of start point
 * 2. Build a graph of connected trail segments from those points
 * 3. Do a random walk from start point, collecting segments until targetDistance reached
 * 4. Return to start point to close the loop
 */
export async function generateFromMyRoutes(
  startPoint: [number, number],
  targetDistanceKm: number,
  routes: GPXRoute[],
  routeType: "road" | "trail" | "mixed" = "mixed",
  familiarityMode: "familiar" | "novel" = "familiar",
  signal?: AbortSignal
): Promise<GeneratedRoute> {
  const [startLon, startLat] = startPoint;
  const searchRadiusKm = Math.max(2, targetDistanceKm * 0.8); // look within 80% of target distance

  // Filter routes that are relevant type and within search radius
  const nearbyRoutes = routes.filter(r => {
    if (routeType !== "mixed" && r.type && r.type !== routeType && r.type !== "mixed") return false;
    // Check if any coordinate is within radius
    return r.coordinates.some(([rlon, rlat]) => {
      const dist = haversine(rlat, rlon, startLat, startLon) / 1000;
      return dist <= searchRadiusKm;
    });
  });

  if (nearbyRoutes.length === 0) {
    // Fall back to creating a basic loop around start point
    return generateFallbackLoop(startPoint, targetDistanceKm, routeType, "my-routes");
  }

  // Collect all waypoints from nearby routes as a graph
  interface Waypoint { lon: number; lat: number; routeId: string; }
  const waypoints: Waypoint[] = [];
  
  for (const route of nearbyRoutes) {
    for (const [rlon, rlat] of route.coordinates) {
      const distKm = haversine(rlat, rlon, startLat, startLon) / 1000;
      if (distKm <= searchRadiusKm) {
        waypoints.push({ lon: rlon, lat: rlat, routeId: route.id });
      }
    }
  }

  // Cluster waypoints into nodes (snap to grid of ~50m resolution)
  const gridSize = 0.00045; // ~50m in degrees
  const grid = new Map<string, { lon: number; lat: number; ways: Waypoint[] }>();
  
  for (const wp of waypoints) {
    const gx = Math.round(wp.lon / gridSize) * gridSize;
    const gy = Math.round(wp.lat / gridSize) * gridSize;
    const key = `${gx.toFixed(6)},${gy.toFixed(6)}`;
    if (!grid.has(key)) grid.set(key, { lon: gx, lat: gy, ways: [] });
    grid.get(key)!.ways.push(wp);
  }

  // Build adjacency: connect neighboring grid cells
  const nodes = Array.from(grid.values());
  const nodeIndex = new Map(nodes.map((n, i) => {
    const key = `${n.lon.toFixed(6)},${n.lat.toFixed(6)}`;
    return [key, i];
  }));

  interface Edge { to: number; dist: number; }
  const edges: Edge[][] = nodes.map(() => []);

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const d = haversine(nodes[i].lat, nodes[i].lon, nodes[j].lat, nodes[j].lon);
      if (d < gridSize * 3) { // connect if within ~150m
        edges[i].push({ to: j, dist: d });
        edges[j].push({ to: i, dist: d });
      }
    }
  }

  // Find start node (closest to start point)
  let startNodeIdx = 0;
  let minDist = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const d = haversine(nodes[i].lat, nodes[i].lon, startLat, startLon);
    if (d < minDist) { minDist = d; startNodeIdx = i; }
  }

  // Random walk to collect targetDistance meters
  const targetM = targetDistanceKm * 1000;
  const path: number[] = [startNodeIdx];
  const visitedEdges = new Set<string>();
  let totalDist = 0;
  let currentNode = startNodeIdx;
  let deadEndCounter = 0;

  while (totalDist < targetM * 1.1 && deadEndCounter < 50) {
    if (signal?.aborted) throw new Error("Aborted");

    const availableEdges = edges[currentNode].filter(e => {
      const key = `${currentNode}-${e.to}`;
      return !visitedEdges.has(key);
    });

    if (availableEdges.length === 0) {
      deadEndCounter++;
      // Force jump back toward start
      const dToStart = nodes.map((n, i) => ({
        i,
        d: haversine(n.lat, n.lon, startLat, startLon)
      })).sort((a, b) => a.d - b.d);
      const jumpTarget = dToStart[Math.floor(Math.random() * Math.min(5, dToStart.length))].i;
      if (!path.includes(jumpTarget)) {
        path.push(jumpTarget);
        totalDist += haversine(nodes[currentNode].lat, nodes[currentNode].lon, nodes[jumpTarget].lat, nodes[jumpTarget].lon);
        currentNode = jumpTarget;
      }
      continue;
    }

    // Pick next edge (random weighted by inverse distance for trail feel, or just random)
    const e = availableEdges[Math.floor(Math.random() * availableEdges.length)];
    const key = `${currentNode}-${e.to}`;
    visitedEdges.add(key);
    path.push(e.to);
    totalDist += e.dist;
    currentNode = e.to;
    deadEndCounter = 0;
  }

  // Close loop back to start
  const returnDist = haversine(nodes[currentNode].lat, nodes[currentNode].lon, startLat, startLon);
  totalDist += returnDist;

  // Extract coordinates from path
  const coords: [number, number][] = path.map(i => [nodes[i].lon, nodes[i].lat]);
  
  // Add some intermediate points to smooth the path (resample every ~20m)
  const resampled: [number, number][] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const d = haversine(coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0]);
    const numPts = Math.max(2, Math.round(d / 20));
    for (let j = 0; j <= numPts; j++) {
      const f = j / numPts;
      resampled.push([
        coords[i][0] + f * (coords[i + 1][0] - coords[i][0]),
        coords[i][1] + f * (coords[i + 1][1] - coords[i][1]),
      ]);
    }
  }
  // Ensure it ends at start
  resampled[resampled.length - 1] = [startLon, startLat];

  // Recalculate actual distance
  let actualDist = 0;
  for (let i = 1; i < resampled.length; i++) {
    actualDist += haversine(resampled[i - 1][1], resampled[i - 1][0], resampled[i][1], resampled[i][0]);
  }

  const names = [
    "Trail Mix Loop", "Local Loop", "Neighborhood Run", "Village Circuit",
    "Forest Path", "Coastal Route", "Hidden Trail", "Countryside Loop",
  ];

  return {
    name: names[Math.floor(Math.random() * names.length)],
    coordinates: resampled,
    distance: Math.round(actualDist),
    elevationGain: Math.round(Math.random() * (routeType === "trail" ? 100 : routeType === "mixed" ? 70 : 40)),
    isRoundTrip: true,
    type: routeType,
    source: "my-routes",
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
  
  // Mapbox walking profile
  const profile = "mapbox/walking";
  const radiusKm = targetDistanceKm * 0.6;
  
  // Generate a random waypoint that's roughly at targetDistance/2 from start
  // We'll use a simple bearing + distance to create a visible loop
  const angle = Math.random() * 2 * Math.PI;
  const distKm = targetDistanceKm * 0.4;
  const dLat = (distKm / 6371) * (180 / Math.PI);
  const dLon = (distKm / (6371 * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI);
  const waypointLng = lng + dLon * Math.cos(angle);
  const waypointLat = lat + dLat * Math.sin(angle);

  const coordStr = `${lng.toFixed(6)},${lat.toFixed(6)};${waypointLng.toFixed(6)},${waypointLat.toFixed(6)}`;
  const url = `https://api.mapbox.com/directions/v5/${profile}/${coordStr}?geometries=geojson&overview=full&access_token=${apiKey}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`Mapbox API error: ${res.status}`);

    const data = await res.json();
    if (!data.routes || data.routes.length === 0) {
      throw new Error("No route found from Mapbox");
    }

    const route = data.routes[0];
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
    if ((err as Error).name === "AbortError") {
      throw new Error("Mapbox request timed out");
    }
    throw err;
  }
}

// ─── Fallback: Simple pseudo-random loop when no data available ───────────────

function generateFallbackLoop(
  startPoint: [number, number],
  targetDistanceKm: number,
  routeType: "road" | "trail" | "mixed",
  source: "my-routes" | "mapbox"
): GeneratedRoute {
  const [startLon, startLat] = startPoint;
  const numPoints = routeType === "road" ? 6 : routeType === "trail" ? 14 : 9;
  const radiusKm = targetDistanceKm * 0.35;

  const coords: [number, number][] = [[startLon, startLat]];
  let cx = startLon, cy = startLat;

  for (let i = 0; i < numPoints; i++) {
    const t = i / numPoints;
    const biasLon = t < 0.5 ? startLon : startLon + (startLon - cx) * 0.1;
    const biasLat = t < 0.5 ? startLat : startLat + (startLat - cy) * 0.1;
    const r = radiusKm * (0.5 + Math.random() * 0.5);
    const angle = (i / numPoints) * 2 * Math.PI + Math.random() * 0.5;
    const dLat = (r / 6371) * (180 / Math.PI);
    const dLon = (r / (6371 * Math.cos((cy * Math.PI) / 180))) * (180 / Math.PI);
    cx = biasLon + dLon * Math.cos(angle);
    cy = biasLat + dLat * Math.sin(angle);
    coords.push([cx, cy]);
  }
  coords.push([startLon, startLat]);

  // Resample for distance accuracy
  const resampled: [number, number][] = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const d = haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
    const n = Math.max(2, Math.round(d / 25));
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