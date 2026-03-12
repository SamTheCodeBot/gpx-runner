"use client";

import { useEffect } from "react";
import { MapContainer, TileLayer, Polyline, useMap } from "react-leaflet";
import L from "leaflet";
import { GPXRoute } from "@/app/types";

interface MapProps {
  routes: GPXRoute[];
  selectedRoute: GPXRoute | null;
  showHeatmap: boolean;
}

function MapController({ routes, selectedRoute }: { routes: GPXRoute[]; selectedRoute: GPXRoute | null }) {
  const map = useMap();

  useEffect(() => {
    if (routes.length === 0) return;

    if (selectedRoute && selectedRoute.coordinates.length > 0) {
      // Fit to selected route
      const bounds = L.latLngBounds(
        selectedRoute.coordinates.map(([lon, lat]) => [lat, lon] as [number, number])
      );
      map.fitBounds(bounds, { padding: [50, 50] });
    } else if (routes.length > 0) {
      // Fit to all routes
      const allCoords = routes.flatMap((r) => r.coordinates);
      const bounds = L.latLngBounds(
        allCoords.map(([lon, lat]) => [lat, lon] as [number, number])
      );
      map.fitBounds(bounds, { padding: [50, 50] });
    }
  }, [map, routes, selectedRoute]);

  return null;
}

export default function Map({ routes, selectedRoute, showHeatmap }: MapProps) {
  // Calculate center from routes or use default ( Stockholm)
  const getCenter = () => {
    if (routes.length === 0) return [59.3293, 18.0686] as [number, number]; // Stockholm
    
    const allCoords = routes.flatMap((r) => r.coordinates);
    if (allCoords.length === 0) return [59.3293, 18.0686] as [number, number];
    
    const avgLat = allCoords.reduce((sum, [_lon, lat]) => sum + lat, 0) / allCoords.length;
    const avgLon = allCoords.reduce((sum, [lon, _lat]) => sum + lon, 0) / allCoords.length;
    
    return [avgLat, avgLon] as [number, number];
  };

  // Create heatmap-like effect by drawing lines with opacity based on frequency
  const getHeatmapRoutes = () => {
    if (!showHeatmap || routes.length === 0) return [];

    // Simple approach: draw all routes with some transparency
    return routes.map((route) => ({
      positions: route.coordinates.map(([lon, lat]) => [lat, lon] as [number, number]), // eslint-disable-line no-unused-vars
      color: route.color || "#22d3ee",
      weight: selectedRoute?.id === route.id ? 4 : 2,
      opacity: selectedRoute?.id === route.id ? 1 : 0.4,
    }));
  };

  return (
    <MapContainer
      center={getCenter()}
      zoom={13}
      style={{ height: "100%", width: "100%", background: "#111113" }}
      zoomControl={true}
    >
      <TileLayer
        attribution='&copy; <a href="https://carto.com/">CARTO</a>'
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
      />
      
      <MapController routes={routes} selectedRoute={selectedRoute} />

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
