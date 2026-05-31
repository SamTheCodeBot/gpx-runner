import { NextRequest, NextResponse } from 'next/server';
import { generateOpenRouteServiceRoundTrip } from "@/api/routeGeneratorService";

type SuggestionRequest = {
  distance?: number;
  avoidFamiliar?: boolean;
  centerLat?: number;
  centerLon?: number;
  preferQuiet?: boolean;
  preferGreen?: boolean;
  elevationPreference?: 'any' | 'hilly' | 'flat';
  directionShift?: number;
  existingRoutes?: { coordinates?: [number, number][] }[];
};

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as SuggestionRequest;

    if (!Number.isFinite(body.distance) || !Number.isFinite(body.centerLat) || !Number.isFinite(body.centerLon)) {
      return NextResponse.json({ error: 'Invalid route request' }, { status: 400 });
    }

    const targetDistanceKm = Math.min(100, Math.max(1, Number(body.distance)));
    const start = { lat: Number(body.centerLat), lng: Number(body.centerLon) };
    const result = await generateOpenRouteServiceRoundTrip({
      start,
      targetDistanceKm,
      toleranceKm: 0.5,
      alternatives: 3,
      routeStyle: 'mixed',
      preferQuiet: Boolean(body.preferQuiet),
      preferGreen: Boolean(body.preferGreen),
      elevationPreference: body.elevationPreference ?? 'any',
      directionShift: Number.isFinite(body.directionShift) ? Number(body.directionShift) : 0,
    });

    const best = result.routes[0];
    if (!best) {
      const message = result.unsafeRejectedCount > 0
        ? 'No route found that avoids the highest-traffic roads from this start point.'
        : 'No loop route found from this start point.';
      return NextResponse.json({ error: message }, { status: 422 });
    }

    return NextResponse.json({
      coordinates: best.geometry.map((point) => [point.lng, point.lat] as [number, number]),
      distance: best.distanceMeters,
      elevationGain: best.elevationGainMeters,
      samples: best.geometry.map((point) => ({
        coordinate: [point.lng, point.lat] as [number, number],
        elevation: point.elevation,
      })),
      name: `Suggested Loop - ${(best.distanceMeters / 1000).toFixed(1)}km`,
      isRoundTrip: true,
      type: 'mixed',
      startPoint: [Number(body.centerLon), Number(body.centerLat)] as [number, number],
      debug: best.debug,
      source: 'openrouteservice-round-trip',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to generate route';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
