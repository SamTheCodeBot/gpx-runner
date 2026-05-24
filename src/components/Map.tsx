"use client";

import { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, Polyline, Marker, Popup, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
// Use canvas renderer for much faster rendering of many polylines
const canvasRenderer = L.canvas({ padding: 0.5 });
import { GPXRoute, RouteSuggestion } from "@/app/types";

interface MapProps {
  routes: GPXRoute[];
  selectedRoute: GPXRoute | null;
  showHeatmap: boolean;
  fitAllRoutes?: boolean;
  showPersonalHeatmap?: boolean;
  personalHeatmapMode?: "frequency" | "pace" | "heart-rate" | "elevation";
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

function MapController({ routes, selectedRoute, suggestedRoute, fitAllRoutes = false }: {
  routes: GPXRoute[];
  selectedRoute: GPXRoute | null;
  suggestedRoute: RouteSuggestion | null;
  fitAllRoutes?: boolean;
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
    } else if (routes.length > 0) {
      targetCoords = routes.flatMap((r) => r.coordinates);
      if (targetCoords.length === 0) return;
      fitKey = `all:${fitAllRoutes ? "full" : "cluster"}:${routes.map((route) => route.id).sort().join("|")}`;
    } else {
      return;
    }

    if (!fitKey || targetCoords.length === 0) return;
    if (lastFitKeyRef.current === fitKey) return;

    if (fitKey.startsWith("all:") && !fitAllRoutes) {
      const toRad = (d: number) => d * Math.PI / 180;
      const R = 6371;
      const kmDist = (lat1: number, lon1: number, lat2: number, lon2: number) => {
        const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
          Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      };
      const routeCentroid = (r: GPXRoute) => {
        const n = r.coordinates.length;
        return [r.coordinates.reduce((s, [lon]) => s + lon, 0) / n, r.coordinates.reduce((s, [, lat]) => s + lat, 0) / n] as [number, number];
      };

      let clusterRoutes = [...routes];
      for (let iter = 0; iter < 4; iter++) {
        const cenLon = clusterRoutes.reduce((s, r) => s + routeCentroid(r)[0], 0) / clusterRoutes.length;
        const cenLat = clusterRoutes.reduce((s, r) => s + routeCentroid(r)[1], 0) / clusterRoutes.length;
        const sorted = clusterRoutes
          .map(r => ({ r, d: kmDist(routeCentroid(r)[1], routeCentroid(r)[0], cenLat, cenLon) }))
          .sort((a, b) => a.d - b.d);
        const mid = Math.floor(sorted.length / 2);
        const medianDist = sorted[mid].d;
        clusterRoutes = sorted.filter(x => x.d <= medianDist * 2.5).map(x => x.r);
        if (clusterRoutes.length <= 1) break;
      }

      if (clusterRoutes.length < 2) clusterRoutes = routes;

      const clusterCoords = clusterRoutes.flatMap(r => r.coordinates);
      const bounds = L.latLngBounds(
        clusterCoords.map(([lon, lat]) => [lat, lon] as [number, number])
      );
      map.fitBounds(bounds, { padding: [50, 50] });
    } else {
      const bounds = L.latLngBounds(
        targetCoords.map(([lon, lat]) => [lat, lon] as [number, number])
      );
      map.fitBounds(bounds, { padding: [50, 50] });
    }
    lastFitKeyRef.current = fitKey;
  }, [map, routes, selectedRoute, suggestedRoute, fitAllRoutes]);

  return null;
}

function MapResizeHandler() {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();
    let frame = 0;
    const invalidate = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => map.invalidateSize({ animate: false }));
    };
    const observer = new ResizeObserver(invalidate);

    observer.observe(container);
    invalidate();

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [map]);

  return null;
}

function calcDistance(coord1: [number, number], coord2: [number, number]): number {
  const R = 6371;
  const dLat = (coord2[1] - coord1[1]) * Math.PI / 180;
  const dLon = (coord2[0] - coord1[0]) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(coord1[1] * Math.PI / 180) * Math.cos(coord2[1] * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getKilometerMarkers(coordinates: [number, number][]): { position: [number, number]; km: number }[] {
  const markers: { position: [number, number]; km: number }[] = [];
  let totalDistance = 0;
  let lastKm = 0;

  for (let i = 1; i < coordinates.length; i++) {
    totalDistance += calcDistance(coordinates[i - 1], coordinates[i]);
    const currentKm = Math.floor(totalDistance);
    if (currentKm > lastKm && currentKm <= 50) {
      markers.push({ position: coordinates[i], km: currentKm });
      lastKm = currentKm;
    }
  }

  return markers;
}

function routeCentroid(route: GPXRoute): [number, number] | null {
  if (!route.coordinates.length) return null;
  return [
    route.coordinates.reduce((sum, [lon]) => sum + lon, 0) / route.coordinates.length,
    route.coordinates.reduce((sum, [, lat]) => sum + lat, 0) / route.coordinates.length,
  ];
}

function RouteClusterMarkers({
  routes,
  enabled,
}: {
  routes: GPXRoute[];
  enabled: boolean;
}) {
  const map = useMap();
  const [mapState, setMapState] = useState({ zoom: map.getZoom(), tick: 0 });

  useEffect(() => {
    const update = () => setMapState((state) => ({ zoom: map.getZoom(), tick: state.tick + 1 }));
    update();
    map.on("moveend zoomend resize", update);
    return () => {
      map.off("moveend zoomend resize", update);
    };
  }, [map]);

  if (!enabled || mapState.zoom >= 9) return null;

  const clusterDistancePx = mapState.zoom <= 5 ? 78 : 58;
  const clusters: Array<{
    routes: GPXRoute[];
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
      existing.lng = existing.routes.reduce((sum, item) => sum + (routeCentroid(item)?.[0] ?? 0), 0) / existing.routes.length;
      existing.lat = existing.routes.reduce((sum, item) => sum + (routeCentroid(item)?.[1] ?? 0), 0) / existing.routes.length;
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
            key={cluster.routes.map((route) => route.id).join("|")}
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

const HEATMAP_RAMPS: Record<string, [[number, number, number], [number, number, number], [number, number, number]]> = {
  road: [
    [255, 185, 215],
    [255, 65, 164],
    [242, 4, 132],
  ],
  trail: [
    [188, 248, 255],
    [18, 221, 251],
    [0, 150, 204],
  ],
  mixed: [
    [231, 190, 255],
    [197, 45, 255],
    [132, 0, 208],
  ],
};

function mixChannel(a: number, b: number, amount: number): number {
  return Math.round(a + (b - a) * amount);
}

function rampColor(type: string | undefined, intensity: number): [number, number, number] {
  const [low, base, high] = HEATMAP_RAMPS[type || "road"] || HEATMAP_RAMPS.road;
  const from = intensity <= 0.55 ? low : base;
  const to = intensity <= 0.55 ? base : high;
  const amount = intensity <= 0.55 ? intensity / 0.55 : (intensity - 0.55) / 0.45;

  return [
    mixChannel(from[0], to[0], amount),
    mixChannel(from[1], to[1], amount),
    mixChannel(from[2], to[2], amount),
  ];
}

function routeTypeIndex(type?: string): number {
  if (type === "trail") return 1;
  if (type === "mixed") return 2;
  return 0;
}

function typeFromIndex(index: number): "road" | "trail" | "mixed" {
  if (index === 1) return "trail";
  if (index === 2) return "mixed";
  return "road";
}

function sampleMetric(sample: NonNullable<GPXRoute["samples"]>[number], mode: "pace" | "heart-rate" | "elevation"): number | null {
  if (mode === "heart-rate") return typeof sample.heartRate === "number" ? sample.heartRate : null;
  if (mode === "elevation") return typeof sample.elevation === "number" ? sample.elevation : null;
  if (typeof sample.paceMinPerKm !== "number") return null;
  return sample.paceMinPerKm > 0 ? 1 / sample.paceMinPerKm : null;
}

function metricRange(routes: GPXRoute[], mode: "pace" | "heart-rate" | "elevation"): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let count = 0;

  for (const route of routes) {
    for (const sample of route.samples || []) {
      const value = sampleMetric(sample, mode);
      if (value === null) continue;
      if (value < min) min = value;
      if (value > max) max = value;
      count += 1;
    }
  }

  return count > 0 ? { min, max } : null;
}

function PersonalMetricHeatmapCanvas({
  routes,
  enabled,
  mode,
}: {
  routes: GPXRoute[];
  enabled: boolean;
  mode: "pace" | "heart-rate" | "elevation";
}) {
  const map = useMap();

  useEffect(() => {
    if (!enabled || routes.length === 0) return;

    const range = metricRange(routes, mode);
    if (!range) return;

    const { min, max } = range;
    const canvas = L.DomUtil.create("canvas", "leaflet-heatmap-canvas") as HTMLCanvasElement;
    canvas.style.position = "absolute";
    canvas.style.pointerEvents = "none";
    canvas.style.zIndex = "450";
    map.getPanes().overlayPane.appendChild(canvas);

    let frame = 0;

    const draw = () => {
      const size = map.getSize();
      const scale = Math.min(window.devicePixelRatio || 1, 1.5);
      const topLeft = map.containerPointToLayerPoint([0, 0]);

      L.DomUtil.setPosition(canvas, topLeft);
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
      canvas.width = Math.max(1, Math.round(size.x * scale));
      canvas.height = Math.max(1, Math.round(size.y * scale));

      const context = canvas.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.lineCap = "round";
      context.lineJoin = "round";

      for (const route of routes) {
        const samples = route.samples;
        if (!samples || samples.length < 2) continue;

        for (let i = 1; i < samples.length; i += 1) {
          const previousValue = sampleMetric(samples[i - 1], mode);
          const currentValue = sampleMetric(samples[i], mode);
          if (previousValue === null && currentValue === null) continue;

          const value = currentValue ?? previousValue ?? min;
          const intensity = max === min ? 0.65 : Math.max(0, Math.min(1, (value - min) / (max - min)));
          const [r, g, b] = rampColor(route.type, intensity);
          const previous = map.latLngToContainerPoint([samples[i - 1].coordinate[1], samples[i - 1].coordinate[0]]);
          const current = map.latLngToContainerPoint([samples[i].coordinate[1], samples[i].coordinate[0]]);

          context.beginPath();
          context.moveTo(previous.x * scale, previous.y * scale);
          context.lineTo(current.x * scale, current.y * scale);
          context.strokeStyle = `rgba(${r}, ${g}, ${b}, ${0.45 + intensity * 0.5})`;
          context.lineWidth = (2.5 + intensity * 8) * scale;
          context.stroke();
        }
      }
    };

    const scheduleDraw = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(draw);
    };

    scheduleDraw();
    map.on("moveend zoomend resize", scheduleDraw);

    return () => {
      window.cancelAnimationFrame(frame);
      map.off("moveend zoomend resize", scheduleDraw);
      canvas.remove();
    };
  }, [enabled, map, mode, routes]);

  return null;
}

function PersonalHeatmapCanvas({ routes, enabled }: { routes: GPXRoute[]; enabled: boolean }) {
  const map = useMap();

  useEffect(() => {
    if (!enabled || routes.length === 0) return;

    const canvas = L.DomUtil.create("canvas", "leaflet-heatmap-canvas") as HTMLCanvasElement;
    canvas.style.position = "absolute";
    canvas.style.pointerEvents = "none";
    canvas.style.zIndex = "450";
    map.getPanes().overlayPane.appendChild(canvas);

    let frame = 0;

    const draw = () => {
      const size = map.getSize();
      const scale = Math.min(window.devicePixelRatio || 1, 1.5);
      const width = Math.max(1, Math.round(size.x * scale));
      const height = Math.max(1, Math.round(size.y * scale));
      const topLeft = map.containerPointToLayerPoint([0, 0]);

      L.DomUtil.setPosition(canvas, topLeft);
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
      canvas.width = width;
      canvas.height = height;

      const context = canvas.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, width, height);

      const densities = [
        new Float32Array(width * height),
        new Float32Array(width * height),
        new Float32Array(width * height),
      ];
      const mask = document.createElement("canvas");
      mask.width = width;
      mask.height = height;
      const maskContext = mask.getContext("2d", { willReadFrequently: true });
      if (!maskContext) return;

      for (const route of routes) {
        if (!route.coordinates || route.coordinates.length < 2) continue;

        maskContext.clearRect(0, 0, width, height);
        maskContext.beginPath();
        route.coordinates.forEach(([lon, lat], index) => {
          const point = map.latLngToContainerPoint([lat, lon]);
          const x = point.x * scale;
          const y = point.y * scale;
          if (index === 0) maskContext.moveTo(x, y);
          else maskContext.lineTo(x, y);
        });
        maskContext.strokeStyle = "rgb(255 255 255)";
        maskContext.lineWidth = 7 * scale;
        maskContext.lineCap = "round";
        maskContext.lineJoin = "round";
        maskContext.stroke();

        const alpha = maskContext.getImageData(0, 0, width, height).data;
        const density = densities[routeTypeIndex(route.type)];
        for (let i = 3, px = 0; i < alpha.length; i += 4, px += 1) {
          if (alpha[i] > 0) density[px] += alpha[i] / 255;
        }
      }

      let maxDensity = 0;
      for (const density of densities) {
        for (let i = 0; i < density.length; i += 1) {
          if (density[i] > maxDensity) maxDensity = density[i];
        }
      }
      if (maxDensity <= 0) return;

      const output = context.createImageData(width, height);
      for (let px = 0, out = 0; px < width * height; px += 1, out += 4) {
        let typeIndex = 0;
        let value = densities[0][px];
        if (densities[1][px] > value) {
          typeIndex = 1;
          value = densities[1][px];
        }
        if (densities[2][px] > value) {
          typeIndex = 2;
          value = densities[2][px];
        }
        if (value <= 0) continue;

        const intensity = maxDensity <= 1 ? 0 : Math.max(0, Math.min(1, (value - 1) / (maxDensity - 1)));
        const [r, g, b] = rampColor(typeFromIndex(typeIndex), intensity);
        output.data[out] = r;
        output.data[out + 1] = g;
        output.data[out + 2] = b;
        output.data[out + 3] = Math.round((0.58 + intensity * 0.37) * Math.min(1, value) * 255);
      }

      context.putImageData(output, 0, 0);
    };

    const scheduleDraw = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(draw);
    };

    scheduleDraw();
    map.on("moveend zoomend resize", scheduleDraw);

    return () => {
      window.cancelAnimationFrame(frame);
      map.off("moveend zoomend resize", scheduleDraw);
      canvas.remove();
    };
  }, [enabled, map, routes]);

  return null;
}

export default function Map({
  routes,
  selectedRoute,
  showHeatmap,
  fitAllRoutes = false,
  showPersonalHeatmap = false,
  personalHeatmapMode = "frequency",
  suggestedRoute,
  selectedStartPoint,
  onMapClick,
  isSelectingStartPoint,
  darkMode = true,
}: MapProps) {
  const [userLocation, setUserLocation] = useState<[number, number] | null>(null);

  useEffect(() => {
    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(
        (position) => setUserLocation([position.coords.latitude, position.coords.longitude]),
        () => {},
        { timeout: 5000, maximumAge: 10 * 60 * 1000 }
      );
    }
  }, []);

  const getCenter = () => {
    if (suggestedRoute && suggestedRoute.coordinates.length > 0) {
      const coords = suggestedRoute.coordinates;
      return [
        coords.reduce((sum, [, lat]) => sum + lat, 0) / coords.length,
        coords.reduce((sum, [lon]) => sum + lon, 0) / coords.length,
      ] as [number, number];
    }
    if (routes.length === 0) return userLocation ?? [59.3293, 18.0686];
    const allCoords = routes.flatMap((r) => r.coordinates);
    if (allCoords.length === 0) return [59.3293, 18.0686];
    return [
      allCoords.reduce((sum, [, lat]) => sum + lat, 0) / allCoords.length,
      allCoords.reduce((sum, [lon]) => sum + lon, 0) / allCoords.length,
    ] as [number, number];
  };

  const simplifyPositions = (coords: [number, number][], maxPoints = 200): [number, number][] => {
    if (coords.length <= maxPoints) return coords;
    const step = Math.ceil(coords.length / maxPoints);
    return coords.filter((_, i) => i % step === 0 || i === coords.length - 1);
  };


  const getHeatmapRoutes = () => {
    if (!showHeatmap || routes.length === 0) return [];

    if (selectedRoute) {
      return [{
        positions: simplifyPositions(selectedRoute.coordinates, 500).map(([lon, lat]) => [lat, lon] as [number, number]),
        color: selectedRoute.type === "trail" ? "rgb(18 221 251)" : selectedRoute.type === "mixed" ? "rgb(197 45 255)" : "rgb(255 65 164)",
        weight: 4,
        opacity: 1,
      }];
    }

    return routes.map((route) => ({
      positions: simplifyPositions(route.coordinates, 500).map(([lon, lat]) => [lat, lon] as [number, number]),
      color: route.type === "trail" ? "rgb(18 221 251)" : route.type === "mixed" ? "rgb(197 45 255)" : "rgb(255 65 164)",
      weight: 1.5,
      opacity: 0.5,
    }));
  };

  const activeRouteCoords = selectedRoute?.coordinates || suggestedRoute?.coordinates || [];
  const kmMarkers = getKilometerMarkers(activeRouteCoords);

  const kmMarkerIcon = (km: number) =>
    L.divIcon({
      html: `<div style="
        background:${darkMode ? "#18181b" : "#ffffff"};
        border:2px solid ${darkMode ? "#22d3ee" : "#0891b2"};
        border-radius:50%;width:24px;height:24px;
        display:flex;align-items:center;justify-content:center;
        font-size:10px;font-weight:bold;
        color:${darkMode ? "#22d3ee" : "#0891b2"};
        box-shadow:0 2px 4px rgba(0,0,0,0.3);
      ">${km}</div>`,
      className: "",
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });

  const startPointIcon = L.divIcon({
    html: `<div style="
      background:#22d3ee;border:3px solid ${darkMode ? "#0a0a0b" : "#ffffff"};
      border-radius:50%;width:30px;height:30px;
      display:flex;align-items:center;justify-content:center;
      font-size:16px;box-shadow:0 0 10px rgba(34,211,238,0.5);
    ">🏃</div>`,
    className: "",
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });

  return (
    <MapContainer
      center={getCenter() as [number, number]}
      zoom={13}
      style={{ height: "100%", width: "100%", background: darkMode ? "#111113" : "#f4f4f5" }}
      zoomControl={true}
      dragging={!isSelectingStartPoint}
      renderer={canvasRenderer}
    >
      <TileLayer
        attribution='&copy; <a href="https://carto.com/">CARTO</a>'
        url={darkMode
          ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
        }
      />

      <MapController routes={routes} selectedRoute={selectedRoute} suggestedRoute={suggestedRoute ?? null} fitAllRoutes={fitAllRoutes} />
      <MapResizeHandler />
      <MapEvents onMapClick={onMapClick} />
      <RouteClusterMarkers routes={routes} enabled={!selectedRoute && !suggestedRoute && routes.length > 0} />
      {personalHeatmapMode === "frequency" ? (
        <PersonalHeatmapCanvas routes={routes} enabled={showPersonalHeatmap && !selectedRoute && !suggestedRoute} />
      ) : (
        <PersonalMetricHeatmapCanvas
          routes={routes}
          enabled={showPersonalHeatmap && !selectedRoute && !suggestedRoute}
          mode={personalHeatmapMode}
        />
      )}

      {selectedStartPoint && (
        <Marker position={[selectedStartPoint[1], selectedStartPoint[0]]} icon={startPointIcon}>
          <Popup>Start/End Point</Popup>
        </Marker>
      )}

      {kmMarkers.map((marker, idx) => (
        <Marker key={idx} position={[marker.position[1], marker.position[0]]} icon={kmMarkerIcon(marker.km)}>
          <Popup>{marker.km} km</Popup>
        </Marker>
      ))}

      {/* Suggested route */}
      {suggestedRoute && suggestedRoute.coordinates.length > 0 && (
        <Polyline
          positions={suggestedRoute.coordinates.map(([lon, lat]) => [lat, lon] as [number, number])}
          pathOptions={{ color: "#f472b6", weight: 5, opacity: 1 }}
        />
      )}

      {/* Standard heatmap */}
      {getHeatmapRoutes().map((route, index) => (
        <Polyline
          key={`heatmap-${index}`}
          positions={route.positions}
          pathOptions={{ color: route.color, weight: route.weight, opacity: route.opacity }}
        />
      ))}

    </MapContainer>
  );
}
