"use client";

import { useEffect, useRef } from "react";
import { MapContainer, TileLayer, Polyline, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

interface RouteSummary {
  id: string;
  name: string;
  type: "road" | "trail" | "mixed";
  coordinates: [number, number][];
}

interface MapAdminProps {
  routes: RouteSummary[];
}

const TYPE_COLORS: Record<string, string> = {
  road: "rgb(255 65 164)",
  trail: "rgb(18 221 251)",
  mixed: "rgb(197 45 255)",
};

function MapAdminController({ routes }: { routes: RouteSummary[] }) {
  const map = useMap();
  const lastBoundsRef = useRef<string | null>(null);

  useEffect(() => {
    if (routes.length === 0) return;

    const allCoords: [number, number][] = [];
    for (const route of routes) {
      for (const [lon, lat] of route.coordinates) {
        allCoords.push([lat, lon]);
      }
    }

    if (allCoords.length === 0) return;

    const bounds = L.latLngBounds(allCoords);
    const boundsKey = bounds.toBBoxString();

    if (lastBoundsRef.current !== boundsKey) {
      map.fitBounds(bounds, { padding: [40, 40] });
      lastBoundsRef.current = boundsKey;
    }
  }, [map, routes]);

  return null;
}

function MapAdminEvents() {
  useMapEvents({ click: () => {} });
  return null;
}

export default function MapAdmin({ routes }: MapAdminProps) {
  const center: [number, number] = routes.length > 0
    ? (() => {
        const allCoords = routes.flatMap(r => r.coordinates);
        if (allCoords.length === 0) return [59.3293, 18.0686] as [number, number];
        const avgLat = allCoords.reduce((s, [, lat]) => s + lat, 0) / allCoords.length;
        const avgLon = allCoords.reduce((s, [lon]) => s + lon, 0) / allCoords.length;
        return [avgLat, avgLon] as [number, number];
      })()
    : [59.3293, 18.0686] as [number, number];

  return (
    <MapContainer
      center={center}
      zoom={13}
      style={{ height: "100%", width: "100%", background: "#111113" }}
      zoomControl={true}
      dragging={true}
      doubleClickZoom={true}
      scrollWheelZoom={true}
      attributionControl={false}
    >
      <TileLayer
        attribution='&copy; <a href="https://carto.com/">CARTO</a>'
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
      />
      <MapAdminController routes={routes} />
      <MapAdminEvents />
      {routes.map((route) => (
        <Polyline
          key={route.id}
          positions={route.coordinates.map(([lon, lat]) => [lat, lon] as [number, number])}
          pathOptions={{
            color: TYPE_COLORS[route.type] || TYPE_COLORS.road,
            weight: 3,
            opacity: 0.85,
            lineCap: "round",
            lineJoin: "round",
          }}
        />
      ))}
    </MapContainer>
  );
}
