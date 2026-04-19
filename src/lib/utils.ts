// Shared utilities for GPX Runner
// All coordinates are [lon, lat] (GeoJSON order) internally, converted for display

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const ROUTE_COLORS = [
  "rgb(255 65 164)", "rgb(18 221 251)",
];
let colorIndex = 0;
export function nextColor(): string {
  const c = ROUTE_COLORS[colorIndex % ROUTE_COLORS.length];
  colorIndex++;
  return c;
}
export function resetColorIndex() { colorIndex = 0; }

export interface ParsedGPX {
  name: string;
  date: string;
  coordinates: [number, number][]; // [lon, lat]
  distance: number;
  elevationGain: number;
}

export function parseGPXFile(text: string, fallbackName: string): ParsedGPX {
  const xml = new DOMParser().parseFromString(text, "application/xml");
  const trkpts = xml.querySelectorAll("trkpt");

  const coordinates: [number, number][] = [];
  let elevationGain = 0;
  let lastElevation: number | null = null;

  trkpts.forEach((pt) => {
    const lat = parseFloat(pt.getAttribute("lat") || "0");
    const lon = parseFloat(pt.getAttribute("lon") || "0");
    const ele = parseFloat(pt.querySelector("ele")?.textContent || "0");
    coordinates.push([lon, lat]);
    if (lastElevation !== null && ele > lastElevation) {
      elevationGain += ele - lastElevation;
    }
    lastElevation = ele;
  });

  let distance = 0;
  for (let i = 1; i < coordinates.length; i++) {
    distance += haversine(coordinates[i - 1][1], coordinates[i - 1][0], coordinates[i][1], coordinates[i][0]);
  }

  const dateStr = xml.querySelector("time")?.textContent || new Date().toISOString();
  const name = xml.querySelector("name")?.textContent || fallbackName;

  return { name, date: new Date(dateStr).toISOString(), coordinates, distance, elevationGain };
}

export function downloadGPXFile(route: { name: string; coordinates: [number, number][] }) {
  const pts = route.coordinates
    .map(([lon, lat]) => `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"><ele>0</ele><time>${new Date().toISOString()}</time></trkpt>`)
    .join("\n");
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GPX running" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${route.name}</name><time>${new Date().toISOString()}</time></metadata>
<trk><name>${route.name}</name><trkseg>${pts}</trkseg></trk>
</gpx>`;
  const blob = new Blob([gpx], { type: "application/gpx+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${route.name.replace(/\s+/g, "_")}.gpx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/** Seeded pseudo-random number generator (Mulberry32) */
function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/**
 * Generate a pseudo-random running route given:
 * - start: [lon, lat]
 * - targetDistanceKm
 * - type: 'road' | 'trail' | 'mixed'
 * - familiarity: 'familiar' | 'novel' (controls how far from start to wander)
 * - existingRoutes: coordinates of user's routes to avoid for novel mode
 */
export function generateRandomRoute(
  start: [number, number],
  targetDistanceKm: number,
  type: "road" | "trail" | "mixed",
  familiarity: "familiar" | "novel",
  existingRoutes: [number, number][][] = [],
  seed = Date.now()
) {
  const rng = mulberry32(seed);
  const [startLon, startLat] = start;

  // Radius in km — familiar stays close, novel wanders farther
  const radiusKm = familiarity === "familiar"
    ? (targetDistanceKm * 0.6) / (2 * Math.PI)
    : (targetDistanceKm * 1.2) / (2 * Math.PI);
  const clampedRadius = Math.max(0.3, Math.min(radiusKm, 8));

  // Road = fewer waypoints (smooth), trail = more (rugged)
  const numWaypoints = type === "road" ? 6 : type === "trail" ? 14 : 10;

  // Helper: pick random point within radius of a center
  const randomNearby = (centerLon: number, centerLat: number, radius: number) => {
    const angle = rng() * 2 * Math.PI;
    const r = Math.sqrt(rng()) * radius; // uniform disc
    const dLat = (r / 6371) * (180 / Math.PI);
    const dLon = (r / (6371 * Math.cos((centerLat * Math.PI) / 180))) * (180 / Math.PI);
    return [
      centerLon + dLon,
      centerLat + dLat,
    ] as [number, number];
  };

  // Build waypoints, biased toward being loop-like
  const waypoints: [number, number][] = [[startLon, startLat]];
  let cx = startLon, cy = startLat;

  for (let i = 0; i < numWaypoints; i++) {
    const t = i / numWaypoints;
    // Bias: first half expands outward, second half returns to start
    const biasLon = t < 0.5 ? startLon : startLon + (startLon - cx) * 0.15;
    const biasLat = t < 0.5 ? startLat : startLat + (startLat - cy) * 0.15;
    cx = (biasLon + cx) / 2 + (rng() - 0.5) * 0.002 * clampedRadius;
    cy = (biasLat + cy) / 2 + (rng() - 0.5) * 0.002 * clampedRadius;
    waypoints.push([cx, cy]);
  }
  waypoints.push([startLon, startLat]); // close the loop

  // Resample each segment into evenly-spaced points to get accurate distance
  const resampled: [number, number][] = [waypoints[0]];
  for (let i = 1; i < waypoints.length; i++) {
    const segDist = haversine(waypoints[i - 1][1], waypoints[i - 1][0], waypoints[i][1], waypoints[i][0]);
    const numPts = Math.max(2, Math.round(segDist / 30)); // ~30m per segment point
    for (let j = 1; j <= numPts; j++) {
      const f = j / numPts;
      resampled.push([
        waypoints[i - 1][0] + f * (waypoints[i][0] - waypoints[i - 1][0]),
        waypoints[i - 1][1] + f * (waypoints[i][1] - waypoints[i - 1][1]),
      ]);
    }
  }

  // Trim or extend to match target distance
  const totalDistKm = (resampled.length - 1) / 2 / 1000; // rough
  const targetPoints = Math.round(resampled.length * (targetDistanceKm / totalDistKm));

  // Simple: stretch/compress the final coordinate to hit target distance
  let coords = resampled;
  if (coords.length > targetPoints) {
    coords = coords.filter((_, i) => i % Math.ceil(coords.length / targetPoints) === 0);
  } else if (coords.length < targetPoints) {
    const expanded: [number, number][] = [];
    for (let i = 0; i < coords.length - 1; i++) {
      expanded.push(coords[i]);
      const steps = Math.ceil(targetPoints / (coords.length - 1));
      for (let j = 1; j < steps; j++) {
        const f = j / steps;
        expanded.push([
          coords[i][0] + f * (coords[i + 1][0] - coords[i][0]),
          coords[i][1] + f * (coords[i + 1][1] - coords[i][1]),
        ]);
      }
    }
    expanded.push(coords[coords.length - 1]);
    coords = expanded;
  }
  // Ensure it ends at start
  if (coords.length > 1) coords[coords.length - 1] = [startLon, startLat];

  // Recalculate actual distance
  let distanceMeters = 0;
  for (let i = 1; i < coords.length; i++) {
    distanceMeters += haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  }

  // Simulate elevation
  const elevationGain = Math.round(rng() * (type === "trail" ? 120 : type === "mixed" ? 80 : 40));

  const names = [
    "Morning Loop", "Exploration Run", "Secret Trail", "Urban Dash",
    "Park Adventure", "River Route", "Hill Repeats", "Evening Stretch",
    "Weekend Warrior", "Recovery Jog",
  ];

  return {
    name: names[Math.floor(rng() * names.length)],
    coordinates: coords,
    distance: Math.round(distanceMeters),
    elevationGain,
    startPoint: start,
    isRoundTrip: true,
    type,
  };
}
