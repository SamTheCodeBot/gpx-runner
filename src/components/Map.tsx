"use client";

import { useEffect, useCallback } from "react";
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

  useEffect(() => {
    let targetCoords: [number, number][] = [];

    if (suggestedRoute && suggestedRoute.coordinates.length > 0) {
      targetCoords = suggestedRoute.coordinates;
    } else if (selectedRoute && selectedRoute.coordinates.length > 0) {
      targetCoords = selectedRoute.coordinates;
    } else if (routes.length > 0) {
      targetCoords = routes.flatMap((r) => r.coordinates);
    }

    if (targetCoords.length === 0) return;

    const bounds = L.latLngBounds(
      targetCoords.map(([lon, lat]) => [lat, lon] as [number, number])
    );
    map.fitBounds(bounds, { padding: [50, 50] });
  }, [map, routes, selectedRoute, suggestedRoute]);

  return null;
}

export default function Map({ 
  routes, 
  selectedRoute, 
  showHeatmap, 
  suggestedRoute, 
  selectedStartPoint,
  onMapClick,
  isSelectingStartPoint
}: MapProps) {
  const getCenter = () => {
    if (suggestedRoute && suggestedRoute.coordinates.length > 0) {
      const coords = suggestedRoute.coordinates;
      const avgLat = coords.reduce((sum, [, lat]) => sum + lat, 0) / coords.length;
      const avgLon = coords.reduce((sum, [lon]) => sum + lon, 0) / coords.length;
      return [avgLat, avgLon] as [number, number];
    }
    
    if (routes.length === 0) return [59.3293, 18.0686] as [number, number];
    
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

  // Create a custom icon for the start point
  const startPointIcon = L.divIcon({
    html: `<div style="
      background: #22d3ee;
      border: 3px solid #0a0a0b;
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
      style={{ height: "100%", width: "100%", background: "#111113" }}
      zoomControl={true}
      dragging={!isSelectingStartPoint}
    >
      <TileLayer
        attribution='&copy; <a href="https://carto.com/">CARTO</a>'
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
      />
      
      <MapController routes={routes} selectedRoute={selectedRoute} suggestedRoute={suggestedRoute ?? null} />
      
      {/* Map click events */}
      <MapEvents onMapClick={onMapClick} />

      {/* Draw selected start point marker */}
      {selectedStartPoint && (
        <Marker position={[selectedStartPoint[1], selectedStartPoint[0]]} icon={startPointIcon}>
          <Popup>
            Start/End Point
          </Popup>
        </Marker>
      )}

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