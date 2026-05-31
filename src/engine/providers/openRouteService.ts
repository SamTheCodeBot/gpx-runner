import { LatLng, RouteProvider, RouteProviderResult, RouteRequest } from "../../types";

function encodeCoordinate(point: LatLng): [number, number] {
  return [point.lng, point.lat];
}

const API_TIMEOUT_MS = 10_000;
const DIRECTIONS_URL = "https://api.openrouteservice.org/v2/directions/foot-walking/geojson";

type OpenRouteServiceFeature = {
  geometry?: { coordinates?: [number, number][] };
  properties?: { summary?: { distance?: number } };
};

type OpenRouteServiceResponse = {
  features?: OpenRouteServiceFeature[];
};

export class OpenRouteServiceProvider implements RouteProvider {
  constructor(private readonly apiKey: string) {}

  async route(input: RouteRequest): Promise<RouteProviderResult | null> {
    if (!this.apiKey) {
      throw new Error("Missing OPENROUTESERVICE_API_KEY");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
      const response = await fetch(DIRECTIONS_URL, {
        method: "POST",
        headers: this.headers(),
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
      });
      clearTimeout(timeout);

      if (!response.ok) {
        return null;
      }

      return this.parseRoute(await response.json());
    } catch {
      clearTimeout(timeout);
      return null;
    }
  }

  async roundTrip(input: { start: LatLng; targetDistanceMeters: number; points?: number; seed?: number }): Promise<RouteProviderResult | null> {
    if (!this.apiKey) {
      throw new Error("Missing OPENROUTESERVICE_API_KEY");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
      const response = await fetch(DIRECTIONS_URL, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          coordinates: [encodeCoordinate(input.start)],
          instructions: false,
          elevation: false,
          options: {
            avoid_features: ["ferries"],
            round_trip: {
              length: Math.round(input.targetDistanceMeters),
              points: input.points ?? 5,
              seed: input.seed,
            },
          },
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        return null;
      }

      return this.parseRoute(await response.json());
    } catch {
      clearTimeout(timeout);
      return null;
    }
  }

  private headers() {
    return {
      Authorization: this.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json, application/geo+json",
    };
  }

  private parseRoute(json: unknown): RouteProviderResult | null {
    const feature = (json as OpenRouteServiceResponse).features?.[0];
    const coords = feature?.geometry?.coordinates;
    const distance = feature?.properties?.summary?.distance;

    if (!coords || !Number.isFinite(distance)) {
      return null;
    }

    return {
      distanceMeters: Number(distance),
      geometry: coords.map(([lng, lat]) => ({ lat, lng })),
    };
  }
}
