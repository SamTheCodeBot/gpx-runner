export interface GPXRoute {
  id: string;
  name: string;
  date: string;
  coordinates: [number, number][]; // [lon, lat]
  distance: number; // meters
  elevationGain: number; // meters
  duration?: number; // minutes
  color: string;
}

export interface RouteStats {
  totalRuns: number;
  totalDistance: number; // km
  totalElevation: number; // meters
  totalTime: number; // minutes
}

export interface RouteFilter {
  month?: string; // YYYY-MM
  minDistance?: number; // km
  maxDistance?: number; // km
}

export interface RouteSuggestionRequest {
  distance: number; // km
  type: 'road' | 'trail' | 'mixed';
  avoidFamiliar: boolean;
  centerLat: number;
  centerLon: number;
}

export interface RouteSuggestion {
  coordinates: [number, number][];
  distance: number;
  elevationGain: number;
  name: string;
  startPoint?: [number, number]; // [lon, lat]
}
