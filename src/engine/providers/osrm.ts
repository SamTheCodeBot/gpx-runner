import { LatLng, RouteProvider, RouteProviderResult, RouteRequest } from "../../types";

const API_TIMEOUT_MS = 15_000;

export class OsmRoutingProvider implements RouteProvider {
  constructor(private readonly baseUrl: string) {
    if (!baseUrl) throw new Error("Missing OSRM_URL environment variable");
  }

  async route(input: RouteRequest): Promise<RouteProviderResult | null> {
    if (!input.coordinates || input.coordinates.length < 2) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
      const coordsStr = input.coordinates
        .map((c) => `${c.lng.toFixed(6)},${c.lat.toFixed(6)}`)
        .join(";");

      const url = `${this.baseUrl}/route/v1/foot/${coordsStr}?overview=full&geometries=geojson&steps=false`;

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) return null;

      const json = (await response.json()) as {
        code?: string;
        routes?: Array<{
          distance?: number;
          geometry?: { coordinates?: [number, number][] };
        }>;
      };

      if (json.code && json.code !== "Ok") return null;

      const route = json.routes?.[0];
      if (!route?.geometry?.coordinates || route.distance == null) return null;

      return {
        distanceMeters: route.distance,
        geometry: route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
      };
    } catch {
      clearTimeout(timeout);
      return null;
    }
  }
}