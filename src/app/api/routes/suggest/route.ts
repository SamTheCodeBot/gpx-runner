import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';

const OSRM_BASE = 'https://router.project-osrm.org';

function calculateFamiliarity(routeCoords: [number, number][], existingRoutes: { coordinates: [number, number][] }[]): number {
  if (existingRoutes.length === 0) return 0;
  
  const familiarCoords = new Set<string>();
  existingRoutes.forEach(route => {
    route.coordinates.forEach(coord => {
      const key = `${coord[0].toFixed(4)},${coord[1].toFixed(4)}`;
      familiarCoords.add(key);
    });
  });
  
  let familiarPoints = 0;
  routeCoords.forEach(coord => {
    const key = `${coord[0].toFixed(4)},${coord[1].toFixed(4)}`;
    if (familiarCoords.has(key)) familiarPoints++;
  });
  
  return familiarPoints / routeCoords.length;
}

interface SuggestionRequest {
  distance: number;
  avoidFamiliar: boolean;
  centerLat: number;
  centerLon: number;
  existingRoutes?: { coordinates: [number, number][] }[];
}

export async function POST(request: NextRequest) {
  try {
    const body: SuggestionRequest = await request.json();
    const { distance, avoidFamiliar, centerLat, centerLon, existingRoutes } = body;

    // Target distance in meters
    const targetMeters = distance * 1000;
    
    // Calculate a point roughly half the target distance away
    // Using ~0.009 degrees per km approximation
    const halfDistanceKm = distance / 2;
    const angle = Math.random() * 2 * Math.PI;
    
    // Calculate waypoint at half the distance
    const waypointLat = centerLat + Math.sin(angle) * halfDistanceKm * 0.009;
    const waypointLon = centerLon + Math.cos(angle) * halfDistanceKm * 0.009;

    // If familiar mode, find a waypoint near existing routes
    if (!avoidFamiliar && existingRoutes && existingRoutes.length > 0) {
      const allCoords = existingRoutes.flatMap(r => r.coordinates);
      if (allCoords.length > 0) {
        // Find a point from existing routes that's at roughly half our target distance
        const relevantPoints = allCoords.filter(c => {
          const d = Math.sqrt(
            Math.pow(c[1] - centerLat, 2) + 
            Math.pow(c[0] - centerLon, 2)
          ) * 111;
          return d >= halfDistanceKm * 0.5 && d <= halfDistanceKm * 1.5;
        });
        
        if (relevantPoints.length > 0) {
          const selectedPoint = relevantPoints[Math.floor(Math.random() * relevantPoints.length)];
          // Return a simple round trip to that point
          const routeCoords: [number, number][] = [
            [centerLon, centerLat],
            [selectedPoint[0], selectedPoint[1]],
            [centerLon, centerLat]
          ];
          
          const familiarity = calculateFamiliarity(routeCoords, existingRoutes);
          
          return NextResponse.json({
            coordinates: routeCoords,
            distance: targetMeters,
            elevationGain: Math.round(distance * 10),
            name: `Familiar Loop - ${distance}km`,
            isRoundTrip: true,
            startPoint: [centerLon, centerLat],
            familiarityScore: Math.round(familiarity * 100),
          });
        }
      }
    }

    // Simple round trip: start -> waypoint -> start
    const coordString = `${centerLon},${centerLat};${waypointLon},${waypointLat};${centerLon},${centerLat}`;
    
    const response = await axios.get(
      `${OSRM_BASE}/route/v1/foot/${coordString}`,
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
      // Fallback: just return a simple route manually
      const fallbackCoords: [number, number][] = [
        [centerLon, centerLat],
        [waypointLon, waypointLat],
        [centerLon, centerLat]
      ];
      
      return NextResponse.json({
        coordinates: fallbackCoords,
        distance: targetMeters,
        elevationGain: Math.round(distance * 10),
        name: `Loop - ${distance}km`,
        isRoundTrip: true,
        startPoint: [centerLon, centerLat],
        familiarityScore: 0,
      });
    }

    const route = response.data.routes[0];
    const coords = route.geometry.coordinates.map((c: number[]) => [c[0], c[1]] as [number, number]);
    const routeDistance = route.distance;
    const familiarity = existingRoutes ? calculateFamiliarity(coords, existingRoutes) : 0;
    
    // Verify we got a valid route (not garbage)
    if (coords.length < 10 || routeDistance < targetMeters * 0.5 || routeDistance > targetMeters * 2) {
      // Return fallback
      const fallbackCoords: [number, number][] = [
        [centerLon, centerLat],
        [waypointLon, waypointLat],
        [centerLon, centerLat]
      ];
      
      return NextResponse.json({
        coordinates: fallbackCoords,
        distance: targetMeters,
        elevationGain: Math.round(distance * 10),
        name: `Loop - ${distance}km`,
        isRoundTrip: true,
        startPoint: [centerLon, centerLat],
        familiarityScore: 0,
      });
    }

    const routeNames = [
      'Morning Loop', 'Evening Run', 'Park Circuit', 'Urban Loop',
      'Nature Trail', 'City Route', 'Sunset Run', 'Quick Loop',
      'Round Route', 'Neighborhood Loop',
    ];

    return NextResponse.json({
      coordinates: coords,
      distance: routeDistance,
      elevationGain: Math.round(distance * 10),
      name: `${routeNames[Math.floor(Math.random() * routeNames.length)]} - ${distance}km`,
      isRoundTrip: true,
      startPoint: [centerLon, centerLat],
      familiarityScore: Math.round(familiarity * 100),
    });

  } catch (error: any) {
    console.error('Route suggestion error:', error.message);
    
    return NextResponse.json(
      { error: 'Failed to generate route. Please try again.' },
      { status: 500 }
    );
  }
}