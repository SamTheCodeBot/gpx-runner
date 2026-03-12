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
