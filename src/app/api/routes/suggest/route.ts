import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';

const OSRM_BASE = 'https://router.project-osrm.org';

interface SuggestionRequest {
  distance: number; // km
  type: 'road' | 'trail' | 'mixed';
  avoidFamiliar: boolean;
  centerLat: number;
  centerLon: number;
}

export async function POST(request: NextRequest) {
  try {
    const body: SuggestionRequest = await request.json();
    const { distance, avoidFamiliar, centerLat, centerLon } = body;

    const targetDistanceMeters = distance * 1000;
    
    // Use the provided center coordinates as the starting point
    const startLat = centerLat;
    const startLon = centerLon;

    // Generate a waypoint that's roughly half the distance away
    // Then we'll return to start to make it a round trip
    const angle = Math.random() * 2 * Math.PI;
    const waypointDistanceKm = distance * 0.5;
    const waypointLat = startLat + (Math.sin(angle) * waypointDistanceKm / 111);
    const waypointLon = startLon + (Math.cos(angle) * waypointDistanceKm / 111);

    // Get the outbound route from start to waypoint
    const response = await axios.get(
      `${OSRM_BASE}/route/v1/foot/${startLon},${startLat};${waypointLon},${waypointLat}`,
      {
        params: {
          overview: 'full',
          geometries: 'geojson',
          steps: 'false',
        },
        timeout: 15000,
      }
    );

    if (response.data.code !== 'Ok' || !response.data.routes || response.data.routes.length === 0) {
      return NextResponse.json(
        { error: 'No route found. Try a different location.' },
        { status: 404 }
      );
    }

    const outboundRoute = response.data.routes[0];
    const outboundCoords = outboundRoute.geometry.coordinates.map((c: number[]) => [c[0], c[1]] as [number, number]);
    
    // Create a proper loop by:
    // 1. Taking the outbound route
    // 2. Reversing it (to return)
    // 3. Removing first/last points to avoid duplicates at junction
    const returnCoords = [...outboundCoords].reverse().slice(1, -1);
    const fullCoords = [...outboundCoords, ...returnCoords];
    
    // Calculate total distance (there and back)
    const halfDistance = outboundRoute.distance;
    const totalDistance = halfDistance * 2;
    
    // Estimate elevation (rough approximation)
    const estimatedElevation = Math.round(distance * 10);

    const routeNames = [
      'Morning Loop',
      'Evening Run',
      'Park Circuit',
      'Urban Loop',
      'Nature Trail',
      'City Route',
      'Sunset Run',
      'Quick Loop',
      'Exploration Run',
      'Discovery Trail',
    ];
    const name = routeNames[Math.floor(Math.random() * routeNames.length)];

    // Start coordinates for the response (same as end for round trip)
    const startCoord: [number, number] = [startLon, startLat];

    return NextResponse.json({
      coordinates: fullCoords,
      distance: totalDistance,
      elevationGain: estimatedElevation,
      name: `${name} - ${distance}km`,
      startPoint: startCoord,
    });

  } catch (error: any) {
    console.error('Route suggestion error:', error.response?.data || error.message);
    
    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      return NextResponse.json(
        { error: 'Route service timed out. Please try again.' },
        { status: 504 }
      );
    }
    
    return NextResponse.json(
      { error: 'Failed to generate route. Please try again.' },
      { status: 500 }
    );
  }
}