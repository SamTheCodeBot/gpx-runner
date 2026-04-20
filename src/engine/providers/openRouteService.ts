import { LatLng, RouteProvider, RouteProviderResult, RouteRequest } from "../../types";

function encodeCoordinate(point: LatLng): [number, number] {
  return [point.lng, point.lat];
}

const API_TIMEOUT_MS = 10_000;

export class OpenRouteServiceProvider implements RouteProvider {
  constructor(private readonly apiKey: string) {}

  async route(input: RouteRequest): Promise<RouteProviderResult | null> {
    if (!this.apiKey) {
      throw new Error("Missing OPENROUTESERVICE_API_KEY");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
      const response = await fetch(
        "https://api.openrouteservice.org/v2/directions/foot-walking/geojson",
        {
          method: "POST",
          headers: {
            Authorization: this.apiKey,
            "Content-Type": "application/json",
            Accept: "application/json, application/geo+json",
          },
          body: JSON.stringify({
            coordinates: input.coordinates.map(encodeCoordinate),
            instructions: false,
            elevation: false,
            continue_straight: false,
            options: {
              avoid_features: ["ferries"],
            },
          }),
          signal: controller.signal,
        },
      );
      clearTimeout(timeout);

      if (!response.ok) {
        return null;
      }

      const json = (await response.json()) as {
        features?: Array<{
          geometry?: { coordinates?: [number, number][] };
          properties?: { summary?: { distance?: number } };
        }>;
      };

      const feature = json.features?.[0];
      const coords = feature?.geometry?.coordinates;
      const distance = feature?.properties?.summary?.distance;

      if (!coords || !Number.isFinite(distance)) {
        return null;
      }

      return {
        distanceMeters: Number(distance),
        geometry: coords.map(([lng, lat]) => ({ lat, lng })),
      };
    } catch {
      clearTimeout(timeout);
      return null;
    }
  }
}
