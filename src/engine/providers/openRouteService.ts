import { LatLng, RouteProvider, RouteProviderResult, RouteRequest } from "../../types";

function encodeCoordinate(point: LatLng): [number, number] {
  return [point.lng, point.lat];
}

const API_TIMEOUT_MS = 10_000;
const DIRECTIONS_BASE_URL = "https://api.openrouteservice.org/v2/directions";

type OpenRouteServiceProfile = "foot-walking" | "foot-hiking";
type RouteStyle = "road" | "mixed" | "trail";

type OpenRouteServiceFeature = {
  geometry?: { coordinates?: [number, number, number?][] };
  properties?: {
    summary?: { distance?: number };
    ascent?: number;
    descent?: number;
  };
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
      const response = await fetch(this.directionsUrl("mixed"), {
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

  async roundTrip(input: {
    start: LatLng;
    targetDistanceMeters: number;
    points?: number;
    seed?: number;
    routeStyle?: RouteStyle;
    preferQuiet?: boolean;
    preferGreen?: boolean;
  }): Promise<RouteProviderResult | null> {
    if (!this.apiKey) {
      throw new Error("Missing OPENROUTESERVICE_API_KEY");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
      const response = await fetch(this.directionsUrl(input.routeStyle), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          coordinates: [encodeCoordinate(input.start)],
          instructions: false,
          elevation: true,
          options: {
            ...this.routeOptions(input.routeStyle, input.preferQuiet, input.preferGreen),
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

  private directionsUrl(routeStyle: RouteStyle = "mixed") {
    const profile: OpenRouteServiceProfile = routeStyle === "trail" ? "foot-hiking" : "foot-walking";
    return `${DIRECTIONS_BASE_URL}/${profile}/geojson`;
  }

  private routeOptions(routeStyle: RouteStyle = "mixed", preferQuiet = false, preferGreen = false) {
    const weightings: Record<string, { factor: number }> = {};
    if (preferQuiet) weightings.quiet = { factor: 1.0 };
    if (preferGreen || routeStyle === "trail") weightings.green = { factor: routeStyle === "trail" ? 1.0 : 0.8 };

    return {
      avoid_features: routeStyle === "trail" ? ["ferries", "fords"] : ["ferries", "fords", "steps"],
      ...(Object.keys(weightings).length > 0 ? { profile_params: { weightings } } : {}),
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
      elevationGainMeters: Number.isFinite(feature.properties?.ascent) ? Number(feature.properties?.ascent) : undefined,
      elevationLossMeters: Number.isFinite(feature.properties?.descent) ? Number(feature.properties?.descent) : undefined,
      geometry: coords.map(([lng, lat, elevation]) => ({
        lat,
        lng,
        elevation: Number.isFinite(elevation) ? Number(elevation) : undefined,
      })),
    };
  }
}
