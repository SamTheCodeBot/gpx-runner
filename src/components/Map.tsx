"use client";

import { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, Polyline, Marker, Popup, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { GPXRoute, RouteSuggestion } from "@/app/types";

interface MapProps {
  routes: GPXRoute[];
  selectedRoute: GPXRoute | null;
  showHeatmap: boolean;
  suggestedRoute?: RouteSuggestion | null;
  selectedStartPoint?: [number, number] | null;
  onMapClick?: (lat: number, lon: number) => void;
  isSelectingStartPoint?: boolean;
  darkMode?: boolean;
}

function MapEvents({ onMapClick }: { onMapClick?: (lat: number, lon: number) => void }) {
  useMapEvents({
    click: (e) => {
      if (onMapClick) {
        onMapClick(e.latlng.lat, e.latlng.lng);
      }
    },
  });
  return null;
}

function MapController({ routes, selectedRoute, suggestedRoute }: { 
  routes: GPXRoute[]; 
  selectedRoute: GPXRoute | null;
  suggestedRoute: RouteSuggestion | null;
}) {
  const map = useMap();
  const lastFitKeyRef = useRef<string | null>(null);

  useEffect(() => {
    let targetCoords: [number, number][] = [];
    let fitKey: string | null = null;

    if (suggestedRoute && suggestedRoute.coordinates.length > 0) {
      targetCoords = suggestedRoute.coordinates;
      fitKey = `suggested:${suggestedRoute.name}:${suggestedRoute.distance}:${suggestedRoute.coordinates.length}`;
    } else if (selectedRoute && selectedRoute.coordinates.length > 0) {
      targetCoords = selectedRoute.coordinates;
      fitKey = `selected:${selectedRoute.id}`;
    } else {
      return;
    }

    if (!fitKey || targetCoords.length === 0) return;
    if (lastFitKeyRef.current === fitKey) return;

    const bounds = L.latLngBounds(
      targetCoords.map(([lon, lat]) => [lat, lon] as [number, number])
    );
    map.fitBounds(bounds, { padding: [50, 50] });
    lastFitKeyRef.current = fitKey;
  }, [map, selectedRoute, suggestedRoute]);

  return null;
}

// Calculate distance between two points in km
function calcDistance(coord1: [number, number], coord2: [number, number]): number {
  const R = 6371;
  const dLat = (coord2[1] - coord1[1]) * Math.PI / 180;
  const dLon = (coord2[0] - coord1[0]) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(coord1[1] * Math.PI / 180) * Math.cos(coord2[1] * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Get kilometer markers for a route
function getKilometerMarkers(coordinates: [number, number][]): { position: [number, number]; km: number }[] {
  const markers: { position: [number, number]; km: number }[] = [];
  let totalDistance = 0;
  let lastKm = 0;
  
  for (let i = 1; i < coordinates.length; i++) {
    const dist = calcDistance(coordinates[i-1], coordinates[i]);
    totalDistance += dist;
    
    const currentKm = Math.floor(totalDistance);
    if (currentKm > lastKm && currentKm <= 50) { // Show up to 50km markers
      markers.push({
        position: coordinates[i],
        km: currentKm
      });
      lastKm = currentKm;
    }
  }
  
  return markers;
}

export default function Map({ 
  routes, 
  selectedRoute, 
  showHeatmap, 
  suggestedRoute, 
  selectedStartPoint,
  onMapClick,
  isSelectingStartPoint,
  darkMode = true
}: MapProps) {
  const [userLocation, setUserLocation] = useState<[number, number] | null>(null);

  useEffect(() => {
    // Request user's geolocation
    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude } = position.coords;
          setUserLocation([latitude, longitude]);
          console.log("User location:", latitude, longitude);
        },
        (error) => {
          console.log("Geolocation error:", error);
          // Silently fail - will use default
        },
        { timeout: 5000 }
      );
    }
  }, []);

  const getCenter = () => {
    if (suggestedRoute && suggestedRoute.coordinates.length > 0) {
      const coords = suggestedRoute.coordinates;
      const avgLat = coords.reduce((sum, [, lat]) => sum + lat, 0) / coords.length;
      const avgLon = coords.reduce((sum, [lon]) => sum + lon, 0) / coords.length;
      return [avgLat, avgLon] as [number, number];
    }
    
    if (routes.length === 0) {
      // Use user's location if available, fallback to Stockholm
      if (userLocation) {
        return userLocation;
      }
      return [59.3293, 18.0686] as [number, number];
    }
    
    const allCoords = routes.flatMap((r) => r.coordinates);
    if (allCoords.length === 0) return [59.3293, 18.0686] as [number, number];
    
    const avgLat = allCoords.reduce((sum, [_lon, lat]) => sum + lat, 0) / allCoords.length;
    const avgLon = allCoords.reduce((sum, [lon, _lat]) => sum + lon, 0) / allCoords.length;
    
    return [avgLat, avgLon] as [number, number];
  };

  const getHeatmapRoutes = () => {
    if (!showHeatmap || routes.length === 0) return [];

    return routes.map((route) => ({
      positions: route.coordinates.map(([lon, lat]) => [lat, lon] as [number, number]),
      color: route.color || "#22d3ee",
      weight: selectedRoute?.id === route.id ? 4 : 2,
      opacity: selectedRoute?.id === route.id ? 1 : 0.4,
    }));
  };

  // Get selected route or suggested route for kilometer markers
  const activeRouteCoords = selectedRoute?.coordinates || suggestedRoute?.coordinates || [];
  const kmMarkers = getKilometerMarkers(activeRouteCoords);

  // Create kilometer marker icon
  const kmMarkerIcon = (km: number) => L.divIcon({
    html: `<div style="
      background: ${darkMode ? '#18181b' : '#ffffff'};
      border: 2px solid ${darkMode ? '#22d3ee' : '#0891b2'};
      border-radius: 50%;
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: bold;
      color: ${darkMode ? '#22d3ee' : '#0891b2'};
      box-shadow: 0 2px 4px rgba(0,0,0,0.3);
    ">${km}</div>`,
    className: '',
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });

  const startPointIcon = L.divIcon({
    html: `<div style="
      background: #22d3ee;
      border: 3px solid ${darkMode ? '#0a0a0b' : '#ffffff'};
      border-radius: 50%;
      width: 30px;
      height: 30px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      box-shadow: 0 0 10px rgba(34, 211, 238, 0.5);
    ">🏃</div>`,
    className: '',
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });

  return (
    <MapContainer
      center={getCenter()}
      zoom={13}
      style={{ height: "100%", width: "100%", background: darkMode ? "#111113" : "#f4f4f5" }}
      zoomControl={true}
      dragging={!isSelectingStartPoint}
    >
      <TileLayer
        attribution='&copy; <a href="https://carto.com/">CARTO</a>'
        url={darkMode 
          ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
        }
      />
      
      <MapController routes={routes} selectedRoute={selectedRoute} suggestedRoute={suggestedRoute ?? null} />
      
      {/* Map click events */}
      <MapEvents onMapClick={onMapClick} />

      {/* Draw selected start point marker */}
      {selectedStartPoint && (
        <Marker position={[selectedStartPoint[1], selectedStartPoint[0]]} icon={startPointIcon}>
          <Popup>Start/End Point</Popup>
        </Marker>
      )}

      {/* Draw kilometer markers for selected/suggested route */}
      {kmMarkers.map((marker, idx) => (
        <Marker 
          key={idx} 
          position={[marker.position[1], marker.position[0]]} 
          icon={kmMarkerIcon(marker.km)}
        >
          <Popup>{marker.km} km</Popup>
        </Marker>
      ))}

      {/* Draw suggested route */}
      {suggestedRoute && suggestedRoute.coordinates.length > 0 && (
        <Polyline
          positions={suggestedRoute.coordinates.map(([lon, lat]) => [lat, lon] as [number, number])}
          pathOptions={{
            color: "#f472b6",
            weight: 5,
            opacity: 1,
          }}
        />
      )}

      {/* Draw heatmap routes */}
      {getHeatmapRoutes().map((route, index) => (
        <Polyline
          key={`heatmap-${index}`}
          positions={route.positions}
          pathOptions={{
            color: route.color,
            weight: route.weight,
            opacity: route.opacity,
          }}
        />
      ))}
    </MapContainer>
  );
}