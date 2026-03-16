export type LatLng = {
  lat: number;
  lng: number;
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
};

export interface RouteProvider {
  route(input: RouteRequest): Promise<RouteProviderResult | null>;
}
