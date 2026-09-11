import type { LatLng, RouteProvider, RouteProviderResult, RouteRequest } from "../../src/types";
import { polylineDistanceMeters } from "../../src/engine/utils/geo";
import { GRID_METERS, latLngToMeters, metersToLatLng } from "./denseHistory";

/**
 * A stand-in for openrouteservice that actually routes.
 *
 * It snaps every requested waypoint onto the street grid the synthetic history
 * was run on and walks between them along that grid, sampling every 10 m. So
 * its output is a real path over real "ways" — never a straight line across a
 * block — which is what lets a test tell provider-routed geometry apart from
 * the raw graph path the search proposes.
 */
export function gridRouter(options: { delayMs?: number } = {}): RouteProvider & {
  calls: RouteRequest[];
} {
  const calls: RouteRequest[] = [];

  return {
    calls,
    async route(request: RouteRequest): Promise<RouteProviderResult | null> {
      calls.push(request);
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (request.coordinates.length < 2) return null;

      const geometry = routeAlongGrid(request.coordinates);
      if (geometry.length < 2) return null;

      return {
        geometry,
        distanceMeters: polylineDistanceMeters(geometry),
        elevationGainMeters: 21,
        extras: undefined,
      };
    },
  };
}

/** Manhattan path over the grid through every waypoint, sampled every 10 m. */
export function routeAlongGrid(waypoints: LatLng[]): LatLng[] {
  const cells = waypoints.map((point) => {
    const { x, y } = latLngToMeters(point);
    return {
      x: Math.round(x / GRID_METERS) * GRID_METERS,
      y: Math.round(y / GRID_METERS) * GRID_METERS,
    };
  });

  const out: LatLng[] = [metersToLatLng(cells[0].x, cells[0].y)];
  let x = cells[0].x;
  let y = cells[0].y;

  const walk = (toX: number, toY: number) => {
    while (x !== toX || y !== toY) {
      const from = metersToLatLng(x, y);
      if (x !== toX) x += Math.sign(toX - x) * GRID_METERS;
      else y += Math.sign(toY - y) * GRID_METERS;
      const to = metersToLatLng(x, y);
      for (let s = 1; s <= 10; s += 1) {
        out.push({
          lat: from.lat + ((to.lat - from.lat) * s) / 10,
          lng: from.lng + ((to.lng - from.lng) * s) / 10,
        });
      }
    }
  };

  for (let i = 1; i < cells.length; i += 1) {
    // Alternate which axis leads so the path does not collapse onto one L.
    if (i % 2 === 0) {
      walk(cells[i].x, y);
      walk(cells[i].x, cells[i].y);
    } else {
      walk(x, cells[i].y);
      walk(cells[i].x, cells[i].y);
    }
  }

  return out;
}
