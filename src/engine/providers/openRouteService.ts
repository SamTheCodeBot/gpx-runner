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

type RoundTripInput = {
  start: LatLng;
  targetDistanceMeters: number;
  points?: number;
  seed?: number;
  routeStyle?: RouteStyle;
  preferQuiet?: boolean;
  preferGreen?: boolean;
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

  async roundTrip(input: RoundTripInput): Promise<RouteProviderResult | null> {
    if (!this.apiKey) {
      throw new Error("Missing OPENROUTESERVICE_API_KEY");
    }

    const attempts = [
      {
        profile: input.routeStyle,
        elevation: true,
        options: this.routeOptions(input.routeStyle, input.preferQuiet, input.preferGreen),
      },
      {
        profile: input.routeStyle,
        elevation: true,
        options: { avoid_features: ["ferries"] },
      },
      {
        profile: "mixed" as RouteStyle,
        elevation: true,
        options: { avoid_features: ["ferries"] },
      },
      {
        profile: "mixed" as RouteStyle,
        elevation: false,
        options: { avoid_features: ["ferries"] },
      },
    ];

    for (const attempt of attempts) {
      const route = await this.requestRoundTrip(input, attempt);
      if (route) return route;
    }

    return null;
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
    const weightings: Record<string, number> = {};
    if (preferQuiet) weightings.quiet = 1;
    if (preferGreen || routeStyle === "trail") weightings.green = 1;

    return {
      avoid_features: routeStyle === "trail" ? ["ferries", "fords"] : ["ferries", "fords", "steps"],
      ...(Object.keys(weightings).length > 0 ? { profile_params: { weightings } } : {}),
    };
  }

  private async requestRoundTrip(
    input: RoundTripInput,
    attempt: { profile?: RouteStyle; elevation: boolean; options: Record<string, unknown> },
  ): Promise<RouteProviderResult | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
      const response = await fetch(this.directionsUrl(attempt.profile), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          coordinates: [encodeCoordinate(input.start)],
          instructions: false,
          elevation: attempt.elevation,
          options: {
            ...attempt.options,
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

  private parseRoute(json: unknown): RouteProviderResult | null {
    const feature = (json as OpenRouteServiceResponse).features?.[0];
    const coords = feature?.geometry?.coordinates;
    const distance = feature?.properties?.summary?.distance;

    if (!coords || !Number.isFinite(distance)) {
      return null;
    }

    return {
      distanceMeters: Number(distance),
      elevationGainMeters: Number.isFinite(feature.properties?.ascent)
        ? Number(feature.properties?.ascent)
        : this.computeElevationGain(coords),
      elevationLossMeters: Number.isFinite(feature.properties?.descent) ? Number(feature.properties?.descent) : undefined,
      geometry: coords.map(([lng, lat, elevation]) => ({
        lat,
        lng,
        elevation: Number.isFinite(elevation) ? Number(elevation) : undefined,
      })),
    };
  }

  private computeElevationGain(coords: [number, number, number?][]): number | undefined {
    let gain = 0;
    let previous: number | null = null;
    let hasElevation = false;

    for (const [, , elevation] of coords) {
      if (!Number.isFinite(elevation)) continue;
      const current = Number(elevation);
      hasElevation = true;
      if (previous !== null && current > previous) gain += current - previous;
      previous = current;
    }

    return hasElevation ? Math.round(gain) : undefined;
  }
}
