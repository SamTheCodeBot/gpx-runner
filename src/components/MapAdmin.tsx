"use client";

import { useState, useEffect, useRef } from "react";
import { MapContainer, TileLayer, Polyline, Marker, Popup, useMap } from "react-leaflet";
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
  darkMode?: boolean;
  clusteringEnabled?: boolean;
}

const TYPE_COLORS: Record<string, string> = {
  road: "rgb(255 65 164)",
  trail: "rgb(18 221 251)",
  mixed: "rgb(197 45 255)",
};

function routeCentroid(route: RouteSummary): [number, number] | null {
  if (!route.coordinates.length) return null;
  return [
    route.coordinates.reduce((sum, [lon]) => sum + lon, 0) / route.coordinates.length,
    route.coordinates.reduce((sum, [, lat]) => sum + lat, 0) / route.coordinates.length,
  ];
}

function MapBoundsController({ routes }: { routes: RouteSummary[] }) {
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

function ClusterMarkers({ routes, enabled }: { routes: RouteSummary[]; enabled: boolean }) {
  const map = useMap();
  const [mapState, setMapState] = useState({ zoom: map.getZoom(), tick: 0 });

  useEffect(() => {
    const update = () => setMapState((state) => ({ zoom: map.getZoom(), tick: state.tick + 1 }));
    update();
    map.on("moveend zoomend resize", update);
    return () => { map.off("moveend zoomend resize", update); };
  }, [map]);

  if (!enabled || mapState.zoom >= 10) return null;

  const clusterDistancePx = mapState.zoom <= 5 ? 78 : 58;
  const clusters: Array<{
    routes: RouteSummary[];
    lng: number;
    lat: number;
    x: number;
    y: number;
  }> = [];

  for (const route of routes) {
    const centroid = routeCentroid(route);
    if (!centroid) continue;
    const [lng, lat] = centroid;
    const point = map.latLngToContainerPoint([lat, lng]);
    const existing = clusters.find((cluster) => {
      const dx = cluster.x - point.x;
      const dy = cluster.y - point.y;
      return Math.sqrt(dx * dx + dy * dy) <= clusterDistancePx;
    });

    if (existing) {
      existing.routes.push(route);
      const totalLng = existing.routes.reduce((s, r) => s + (routeCentroid(r)?.[0] ?? 0), 0);
      const totalLat = existing.routes.reduce((s, r) => s + (routeCentroid(r)?.[1] ?? 0), 0);
      existing.lng = totalLng / existing.routes.length;
      existing.lat = totalLat / existing.routes.length;
      const nextPoint = map.latLngToContainerPoint([existing.lat, existing.lng]);
      existing.x = nextPoint.x;
      existing.y = nextPoint.y;
    } else {
      clusters.push({ routes: [route], lng, lat, x: point.x, y: point.y });
    }
  }

  return (
    <>
      {clusters.map((cluster) => {
        const routeCount = cluster.routes.length;
        const icon = L.divIcon({
          html: '<div style="width:34px;height:34px;border-radius:999px;display:flex;align-items:center;justify-content:center;background:rgb(255 65 164);color:white;border:3px solid white;font-size:13px;font-weight:900;box-shadow:0 4px 14px rgba(0,0,0,0.28);">' + routeCount + '</div>',
          className: "",
          iconSize: [34, 34],
          iconAnchor: [17, 17],
        });

        return (
          <Marker
            key={cluster.routes.map((r) => r.id).join("|")}
            position={[cluster.lat, cluster.lng]}
            icon={icon}
            eventHandlers={{
              click: () => {
                const coords = cluster.routes.flatMap((route) => route.coordinates);
                if (!coords.length) return;
                map.fitBounds(L.latLngBounds(coords.map(([lon, lat]) => [lat, lon] as [number, number])), { padding: [70, 70] });
              },
            }}
          >
            <Popup>
              {routeCount === 1 ? cluster.routes[0].name : routeCount + " routes in this area"}
            </Popup>
          </Marker>
        );
      })}
    </>
  );
}

export default function MapAdmin({ routes, darkMode = true, clusteringEnabled = false }: MapAdminProps) {
  const center: [number, number] = routes.length > 0
    ? (() => {
        const allCoords = routes.flatMap((r) => r.coordinates);
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
      style={{ height: "100%", width: "100%", background: darkMode ? "#111113" : "#f4f4f5" }}
      zoomControl={true}
      dragging={true}
      doubleClickZoom={true}
      scrollWheelZoom={true}
      attributionControl={false}
    >
      <TileLayer
        attribution='&copy; <a href="https://carto.com/">CARTO</a>'
        url={darkMode
          ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
        }
      />
      <MapBoundsController routes={routes} />
      <ClusterMarkers routes={routes} enabled={clusteringEnabled} />
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