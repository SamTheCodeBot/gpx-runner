export type LatLng = {
  lat: number;
  lng: number;
  elevation?: number;
};

export type FamiliarityMode = "familiar" | "mixed" | "new";

/** Road vs trail preference. Maps onto the openrouteservice foot profiles. */
export type RouteStyle = "road" | "mixed" | "trail";

/** What the waytype/noise extras say about how busy a route is. */
export type RouteTrafficSummary = {
  hasTrafficData: boolean;
  stateRoadMeters: number;
  roadMeters: number;
  noisyMeters: number;
  quietWayMeters: number;
  quietWayRatio: number;
  trafficPenalty: number;
  unsafeRoads: boolean;
};

export type RouteSegment = {
  from: LatLng;
  to: LatLng;
  distanceMeters: number;
};

export type GeneratedRoute = {
  id: string;
  distanceMeters: number;
  elevationGainMeters?: number;
  geometry: LatLng[];
  segments: RouteSegment[];
  familiarityRatio: number;
  /** False when the user has no logged tracks near the start — ratio is then a guess, not a measurement. */
  familiarityMeasured: boolean;
  traffic?: RouteTrafficSummary;
  score: number;
  source?: "familiar-graph" | "provider";
  debug: Record<string, number | string | boolean>;
};

export type GenerateRouteInput = {
  start: LatLng;
  targetDistanceKm: number;
  toleranceKm?: number;
  familiarityMode?: FamiliarityMode;
  gpxFiles?: string[];
  routeCollections?: LatLng[][];
  maxCandidates?: number;
  alternatives?: number;
  routeStyle?: RouteStyle;
  preferQuiet?: boolean;
  preferGreen?: boolean;
  /** Reject routes that run along state roads or noisy ways. Defaults to true. */
  avoidUnsafeRoads?: boolean;
  /**
   * Epoch-ms wall clock the whole generation must finish by. Everything inside
   * — the graph search and the provider fan-out — is budgeted against it, and
   * whatever has been found when it expires is returned as best effort.
   */
  deadlineAt?: number;
};

export type GenerateRouteResult = {
  /** Routes matching distance, loop shape, road safety and the requested familiarity band. */
  routes: GeneratedRoute[];
  /**
   * Routes that are good runs but land outside the requested familiarity band.
   * Used to answer "closest match: 55% familiar" instead of showing nothing.
   */
  nearMisses: GeneratedRoute[];
  /**
   * Every route that was built and is not outright broken, best first, whether
   * or not it met the distance or familiarity bands. The answer of last resort:
   * telling the runner "closest match, 64% familiar" beats "no route found".
   */
  bestEffort: GeneratedRoute[];
  rejectedCount: number;
  unsafeRejectedCount: number;
  /** True when the deadline expired and the result is what had been found by then. */
  timedOut: boolean;
};

export type RouteRequest = {
  coordinates: LatLng[];
  routeStyle?: RouteStyle;
  preferQuiet?: boolean;
  preferGreen?: boolean;
  /** Upper bound for this single call. Clamped to the provider's own timeout. */
  timeoutMs?: number;
};

export type RouteProviderResult = {
  geometry: LatLng[];
  distanceMeters: number;
  elevationGainMeters?: number;
  elevationLossMeters?: number;
  extras?: RouteProviderExtras;
};

export type RouteProviderExtras = {
  waytype?: RouteExtraSummary[];
  noise?: RouteExtraSummary[];
};

export type RouteExtraSummary = {
  value: number;
  distance: number;
  amount: number;
};

export interface RouteProvider {
  route(input: RouteRequest): Promise<RouteProviderResult | null>;
}
