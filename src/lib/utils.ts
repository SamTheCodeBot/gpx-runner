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