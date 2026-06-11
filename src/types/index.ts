export type LatLng = {
  lat: number;
  lng: number;
  elevation?: number;
};

export type FamiliarityMode = "familiar" | "mixed" | "new";

export type RouteSegment = {
  from: LatLng;
  to: LatLng;
  distanceMeters: number;
};

export type GeneratedRoute = {
  id: string;
  distanceMeters: number;
  geometry: LatLng[];
  segments: RouteSegment[];
  familiarityRatio: number;
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
};

export type RouteRequest = {
  coordinates: LatLng[];
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

// ── No-go zone / route template ───────────────────────────────────────────
export type LatLngPoint = [number, number]; // [lng, lat]

export interface NoGoZone {
  id: string;
  name: string;
  /** Closed polygon ring — each point is [lng, lat] */
  polygon: LatLngPoint[];
  color: string; // hex, for map display
  createdAt: string; // ISO
}

export interface RouteTemplate {
  id: string;
  userId: string;
  zones: NoGoZone[];
  updatedAt: string; // ISO
}

/** One entry in the undo stack for zone editing */
export type ZoneEditAction =
  | { type: "remove_point"; pointIndex: number; point: LatLngPoint }
  | { type: "move_point"; pointIndex: number; oldPos: LatLngPoint; newPos: LatLngPoint }
  | { type: "add_point"; pointIndex: number; point: LatLngPoint };
