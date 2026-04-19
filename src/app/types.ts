export interface GPXRoute {
  id: string;
  name: string;
  date: string;
  coordinates: [number, number][]; // [lon, lat]
  distance: number; // meters
  elevationGain: number; // meters
  duration?: number; // minutes
  color: string;
  userId?: string; // Firebase user ID for cloud sync
  type?: 'road' | 'trail'; // Route type tag
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
  type?: 'road' | 'trail' | 'all'; // Filter by route type
}

export interface RouteSuggestionRequest {
  distance: number; // km
  type: 'road' | 'trail' | 'mixed';
  avoidFamiliar: boolean;
  centerLat: number;
  centerLon: number;
  existingRoutes?: { coordinates: [number, number][] }[];
}

export interface RouteSuggestion {
  coordinates: [number, number][];
  distance: number;
  elevationGain: number;
  name: string;
  startPoint?: [number, number]; // [lon, lat]
  isRoundTrip?: boolean;
  familiarityScore?: number; // 0-100 percentage
}

export interface UserProfile {
  displayName: string;
  avatar: string; // Material Symbols icon name
  joinedAt: string; // ISO date string
  totalRuns: number; // cached count
  totalDistance: number; // cached km
}