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
  /**
   * True only when `geometry` is what a routing provider returned, so it
   * follows real ways. Graph-derived geometry is 11 m-quantised GPS history
   * stitched shut with straight lines — it can cross houses and water and must
   * never reach the client. Nothing without this flag may be returned.
   */
  routedByProvider: boolean;
  /**
   * True when this is a there-and-back rather than a loop.
   *
   * "Sometimes an out and back might be the only solution. But hey, then it is
   * ok. But we should always try to avoid it." So it is allowed, last, and
   * never quietly: whatever returns this to a runner has to say so.
   */
  isOutAndBack: boolean;
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
   * Real, routed, correctly shaped loops of the right length that land outside
   * the requested familiarity band. Used to answer "closest match: 55%
   * familiar" instead of showing nothing.
   *
   * The familiarity band is the *only* constraint allowed to be missed here.
   * Distance, loop shape and road safety are hard: a route that fails those is
   * not a near miss, it is not a route.
   */
  nearMisses: GeneratedRoute[];
  /**
   * Every route that cleared the constraints that are never negotiable — drawn
   * by the routing provider, a genuine loop, safe roads — best first, whether
   * or not it hit the requested length or familiarity band.
   *
   * The answer of last resort, and only that: telling the runner "closest
   * match, 5.8 km, 64% familiar" beats "no route found", but it is never
   * presented as if it had met the request. Nothing misshapen or unrouted is
   * ever in here — those are not routes at any price.
   */
  bestEffort: GeneratedRoute[];
  /**
   * Properly routed, safe runs of the right length that are not loops — the
   * runner goes out and comes back the same way. The answer only when no loop
   * of any kind could be found, and always labelled as what it is.
   */
  outAndBacks: GeneratedRoute[];
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
