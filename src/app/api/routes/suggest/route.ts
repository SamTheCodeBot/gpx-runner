import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';

// OpenRouteService API key - set in environment variables
const ORS_API_KEY = process.env.ORS_API_KEY || '';

interface SuggestionRequest {
  distance: number; // km
  type: 'road' | 'trail' | 'mixed';
  centerLat: number;
  centerLon: number;
}

export async function POST(request: NextRequest) {
  try {
    const body: SuggestionRequest = await request.json();
    const { distance, type, centerLat, centerLon } = body;

    if (!ORS_API_KEY) {
      return NextResponse.json(
        { error: 'OpenRouteService API key not configured. Please set ORS_API_KEY in environment.' },
        { status: 500 }
      );
    }

    // Generate random start point within reasonable distance of center
    // For a ~5km run, we want start point within ~2km of center
    const radiusKm = 2;
    const startLat = centerLat + (Math.random() - 0.5) * (radiusKm / 111);
    const startLon = centerLon + (Math.random() - 0.5) * (radiusKm / 111);

    // Generate a random end point that makes the route approximately the right distance
    // This is simplified - in production you'd use proper routing to calculate endpoints
    const angle = Math.random() * 2 * Math.PI;
    const distanceRatio = 0.5 + Math.random() * 0.5; // 50-100% of target distance
    const endDistanceKm = distance * distanceRatio;
    
    const endLat = startLat + (Math.sin(angle) * endDistanceKm / 111);
    const endLon = startLon + (Math.cos(angle) * endDistanceKm / 111);

    // Use OpenRouteService Directions API
    const profile = type === 'road' ? 'foot-walking' : 'hiking';
    
    const response = await axios.get(
      `https://api.openrouteservice.org/v2/directions/${profile}/geojson`,
      {
        params: {
          api_key: ORS_API_KEY,
          start: `${startLon},${startLat}`,
          end: `${endLon},${endLat}`,
        },
        timeout: 10000,
      }
    );

    if (!response.data.features || response.data.features.length === 0) {
      return NextResponse.json(
        { error: 'No route found for these points' },
        { status: 404 }
      );
    }

    const route = response.data.features[0];
    const coords = route.geometry.coordinates.map((c: number[]) => [c[0], c[1]] as [number, number]);
    const routeDistance = route.properties.summary.distance;
    const routeElevation = route.properties.summary.ascent || 0;

    // Generate route name
    const routeNames = [
      'Morning Explorer',
      'Sunset Trail',
      'Urban Loop',
      'Nature Path',
      'City Runner',
      'Park Circuit',
      'Trail Blazer',
      'Road Runner',
    ];
    const name = routeNames[Math.floor(Math.random() * routeNames.length)];

    return NextResponse.json({
      coordinates: coords,
      distance: routeDistance,
      elevationGain: routeElevation,
      name: `${name} - ${distance}km`,
    });

  } catch (error: any) {
    console.error('Route suggestion error:', error.response?.data || error.message);
    
    if (error.response?.status === 401) {
      return NextResponse.json(
        { error: 'Invalid OpenRouteService API key' },
        { status: 401 }
      );
    }
    
    return NextResponse.json(
      { error: 'Failed to generate route suggestion' },
      { status: 500 }
    );
  }
}
