import {
  LatLng,
  RoundTripCapableProvider,
  RoundTripRequest,
  RouteExtraSummary,
  RouteProviderFailure,
  RouteProviderFailureKind,
  RouteProviderResult,
  RouteRequest,
  RouteStyle,
} from "../../types";

function encodeCoordinate(point: LatLng): [number, number] {
  return [point.lng, point.lat];
}

const API_TIMEOUT_MS = 10_000;
const DIRECTIONS_BASE_URL = "https://api.heigit.org/openrouteservice/v2/directions";

type OpenRouteServiceProfile = "foot-walking" | "foot-hiking";

type OpenRouteServiceFeature = {
  geometry?: { coordinates?: [number, number, number?][] };
  properties?: {
    summary?: { distance?: number };
    ascent?: number;
    descent?: number;
    extras?: {
      waytype?: OpenRouteServiceExtra;
      waytypes?: OpenRouteServiceExtra;
      noise?: OpenRouteServiceExtra;
    };
  };
};

type OpenRouteServiceResponse = {
  features?: OpenRouteServiceFeature[];
};

type OpenRouteServiceExtra = {
  summary?: Array<{
    value?: number;
    distance?: number;
    amount?: number;
  }>;
};

/**
 * A single call never waits longer than the provider timeout, and never longer
 * than the caller's remaining request budget either. Purely client-side: no
 * openrouteservice parameter is involved.
 */
function callTimeoutMs(requested?: number): number {
  if (!Number.isFinite(requested)) return API_TIMEOUT_MS;
  return Math.max(500, Math.min(API_TIMEOUT_MS, Number(requested)));
}

/**
 * What an HTTP status means for us.
 *
 * 429 is the one that matters most in practice: the free openrouteservice plan
 * allows a limited number of directions calls per minute, a single suggestion
 * can spend dozens of them, and over the limit every call fails at once. Told
 * apart from "no route", that is a two-second diagnosis; folded into it, it
 * looks exactly like a start point with no loops.
 */
function failureKindForStatus(status: number): RouteProviderFailureKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "provider-error";
  return "rejected";
}

/** True when the provider's wording says "quota", whatever status it used. */
function quotaMessage(message?: string): boolean {
  return Boolean(message && /quota|rate.?limit|too many requests/i.test(message));
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

type RoundTripInput = RoundTripRequest;

/** How much of a provider error message is worth keeping. */
const MAX_PROVIDER_MESSAGE_CHARS = 300;

export class OpenRouteServiceProvider implements RoundTripCapableProvider {
  /**
   * Why calls came back empty. Collapsing a 401, a 429 and "no route exists"
   * into the same `null` is what made this provider undiagnosable, so every
   * one of them is recorded here and read back by the caller.
   */
  private readonly failures: RouteProviderFailure[] = [];

  constructor(private readonly apiKey: string) {}

  /** Everything that has gone wrong since the last read. Clears as it returns. */
  takeFailures(): RouteProviderFailure[] {
    return this.failures.splice(0, this.failures.length);
  }

  async route(input: RouteRequest): Promise<RouteProviderResult | null> {
    if (!this.apiKey) {
      throw new Error("Missing OPENROUTESERVICE_API_KEY");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), callTimeoutMs(input.timeoutMs));

    try {
      const response = await fetch(this.directionsUrl(input.routeStyle ?? "mixed"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          coordinates: input.coordinates.map(encodeCoordinate),
          instructions: false,
          elevation: true,
          continue_straight: false,
          // waytype/noise drive road avoidance; without them the waypoint path
          // cannot tell a cycleway from a trunk road.
          extra_info: ["waytype", "noise"],
          options: this.routeOptions(input.routeStyle, input.preferQuiet, input.preferGreen),
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      return await this.readResponse(response);
    } catch (error) {
      clearTimeout(timeout);
      this.recordThrown(error);
      return null;
    }
  }

  async roundTrip(input: RoundTripInput & { timeoutMs?: number }): Promise<RouteProviderResult | null> {
    if (!this.apiKey) {
      throw new Error("Missing OPENROUTESERVICE_API_KEY");
    }

    const attempt =
      input.requestMode === "basic-no-elevation"
        ? {
            profile: "mixed" as RouteStyle,
            elevation: false,
            options: { avoid_features: ["ferries"] },
          }
        : input.requestMode === "basic"
          ? {
              profile: "mixed" as RouteStyle,
              elevation: true,
              options: { avoid_features: ["ferries"] },
            }
          : {
              profile: input.routeStyle,
              elevation: true,
              options: this.routeOptions(input.routeStyle, input.preferQuiet, input.preferGreen),
            };

    return this.requestRoundTrip(input, attempt);
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
    const timeout = setTimeout(() => controller.abort(), callTimeoutMs(input.timeoutMs));

    try {
      const response = await fetch(this.directionsUrl(attempt.profile), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          coordinates: [encodeCoordinate(input.start)],
          instructions: false,
          elevation: attempt.elevation,
          extra_info: ["waytype", "noise"],
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

      return await this.readResponse(response);
    } catch (error) {
      clearTimeout(timeout);
      this.recordThrown(error);
      return null;
    }
  }

  /**
   * Turns one HTTP response into either a route or a recorded reason there is
   * none. The body is read before it is judged: openrouteservice puts the
   * useful part — a numeric code and a sentence — in the error payload, and
   * throwing it away is what left "no route" indistinguishable from "we were
   * refused".
   */
  private async readResponse(response: Response): Promise<RouteProviderResult | null> {
    if (!response.ok) {
      const { code, message } = await this.readErrorBody(response);
      this.failures.push({
        // openrouteservice answers an exhausted quota with 403 as often as 429,
        // and the difference between "you may not" and "not right now" is the
        // difference between a broken key and a busy minute.
        kind: quotaMessage(message)
          ? "rate-limited"
          : failureKindForStatus(response.status),
        status: response.status,
        ...(code !== undefined ? { code } : {}),
        ...(message ? { message } : {}),
      });
      return null;
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      this.failures.push({
        kind: "provider-error",
        status: response.status,
        message: this.redact(`unreadable response body: ${describeError(error)}`),
      });
      return null;
    }

    const parsed = this.parseRoute(json);
    // A 200 with no feature is the one honest "there is no route here".
    if (!parsed) this.failures.push({ kind: "empty", status: response.status });
    return parsed;
  }

  /** The provider's own error code and sentence, if it sent any. */
  private async readErrorBody(response: Response): Promise<{ code?: number; message?: string }> {
    let text = "";
    try {
      text = await response.text();
    } catch {
      return {};
    }
    if (!text) return {};

    try {
      const body = JSON.parse(text) as { error?: { code?: number; message?: string } | string };
      if (typeof body.error === "string") return { message: this.redact(body.error) };
      if (body.error) {
        return {
          ...(Number.isFinite(body.error.code) ? { code: Number(body.error.code) } : {}),
          ...(body.error.message ? { message: this.redact(body.error.message) } : {}),
        };
      }
    } catch {
      // Not JSON — an upstream proxy page, most likely. The text still helps.
    }

    return { message: this.redact(text) };
  }

  private recordThrown(error: unknown): void {
    const aborted =
      error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
    this.failures.push({
      kind: aborted ? "timeout" : "network",
      message: this.redact(describeError(error)),
    });
  }

  /**
   * Nothing leaves this class carrying the API key. The key is sent in a
   * header, so it should never appear in a body — but a proxy that echoes the
   * request would put it there, and a debug field is a place users can see.
   */
  private redact(text: string): string {
    const withoutKey = this.apiKey ? text.split(this.apiKey).join("[redacted]") : text;
    const collapsed = withoutKey.replace(/\s+/g, " ").trim();
    return collapsed.length > MAX_PROVIDER_MESSAGE_CHARS
      ? `${collapsed.slice(0, MAX_PROVIDER_MESSAGE_CHARS)}…`
      : collapsed;
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
      extras: {
        waytype: this.parseExtraSummary(feature.properties?.extras?.waytype ?? feature.properties?.extras?.waytypes),
        noise: this.parseExtraSummary(feature.properties?.extras?.noise),
      },
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

  private parseExtraSummary(extra: OpenRouteServiceExtra | undefined): RouteExtraSummary[] | undefined {
    const summary = extra?.summary;
    if (!Array.isArray(summary)) return undefined;

    const parsed = summary
      .map((item) => ({
        value: Number(item.value),
        distance: Number(item.distance),
        amount: Number(item.amount),
      }))
      .filter((item) => (
        Number.isFinite(item.value) &&
        Number.isFinite(item.distance) &&
        Number.isFinite(item.amount)
      ));

    return parsed.length > 0 ? parsed : undefined;
  }
}
