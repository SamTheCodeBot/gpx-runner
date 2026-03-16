import { NextRequest, NextResponse } from 'next/server';
import { generateTrainingRoutes } from '../../../../../src/api/routeGeneratorService';

type SuggestionRequest = {
  distance?: number;
  avoidFamiliar?: boolean;
  centerLat?: number;
  centerLon?: number;
  existingRoutes?: { coordinates?: [number, number][] }[];
};

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as SuggestionRequest;

    if (!Number.isFinite(body.distance) || !Number.isFinite(body.centerLat) || !Number.isFinite(body.centerLon)) {
      return NextResponse.json({ error: 'Invalid route request' }, { status: 400 });
    }

    const result = await generateTrainingRoutes({
      start: { lat: Number(body.centerLat), lng: Number(body.centerLon) },
      targetDistanceKm: Number(body.distance),
      toleranceKm: 1,
      familiarityMode: body.avoidFamiliar ? 'new' : 'familiar',
      routeCollections: (body.existingRoutes ?? []).map((route) =>
        (route.coordinates ?? []).map(([lng, lat]) => ({ lat, lng })),
      ),
      maxCandidates: 180,
      alternatives: 1,
    });

    const best = result.routes[0];
    if (!best) {
      return NextResponse.json({ error: 'No valid road/trail loop found for the chosen constraints.' }, { status: 422 });
    }

    return NextResponse.json({
      coordinates: best.geometry.map((point) => [point.lng, point.lat] as [number, number]),
      distance: best.distanceMeters,
      elevationGain: 0,
      name: `${body.avoidFamiliar ? 'New' : 'Familiar'} Loop - ${(best.distanceMeters / 1000).toFixed(1)}km`,
      isRoundTrip: true,
      startPoint: [Number(body.centerLon), Number(body.centerLat)] as [number, number],
      familiarityScore: Math.round(best.familiarityRatio * 100),
      debug: best.debug,
      source: best.source,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to generate route';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
