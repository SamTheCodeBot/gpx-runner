"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, Polyline, Marker, Popup, useMap, useMapEvents } from "react-leaflet";
import BaseMapLayer from "./BaseMapLayer";
import L from "leaflet";
// Use canvas renderer for much faster rendering of many polylines
const canvasRenderer = L.canvas({ padding: 0.5 });
import { GPXRoute, RouteSuggestion } from "@/app/types";
import {
  cellAt,
  daysSince,
  frequencyPosition,
  recencyBandIndex,
  type VisitGrid,
} from "@/engine/heatmap";
import type { RouteFamiliaritySegment } from "@/lib/routeFamiliarity";

/**
 * What the heatmap is coloured by.
 *
 * Heart rate is gone, and not by oversight: the ingestion spine deliberately
 * never stores it (`power=false&hr=false` on every download — Art. 9
 * special-category data we chose never to hold), so the mode could only ever
 * have worked for a handful of legacy manual uploads. Offering a view the data
 * cannot fill is worse than not offering it. Recency took its place, and
 * answers a question the history can always answer: what have I not been down
 * in a year?
 */
export type PersonalHeatmapMode = "frequency" | "recency" | "pace";

interface MapProps {
  routes: GPXRoute[];
  selectedRoute: GPXRoute | null;
  showHeatmap: boolean;
  fitAllRoutes?: boolean;
  showPersonalHeatmap?: boolean;
  personalHeatmapMode?: PersonalHeatmapMode;
  /** Counted once, on the ground, by the page that owns the history. */
  heatmapGrid?: VisitGrid | null;
  heatmapStops?: number[];
  heatmapPaceRange?: { min: number; max: number } | null;
  suggestedRoute?: RouteSuggestion | null;
  selectedStartPoint?: [number, number] | null;
  onMapClick?: (lat: number, lon: number) => void;
  isSelectingStartPoint?: boolean;
  darkMode?: boolean;
  familiaritySegments?: RouteFamiliaritySegment[];
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

/**
 * The heatmap ramps.
 *
 * One variable per channel. Colour carries the number and nothing else; width
 * stays constant. The version this replaces put the metric into line width
 * (up to 10 px) and the route *type* into hue, so two unrelated variables
 * shared one channel and neighbouring streets merged into blobs with no value
 * you could read off them.
 *
 * Ordered cold to hot, and chosen to stay distinguishable on the dark
 * basemap: ground run once has to be visible, not merely not-absent, because
 * "where have I been exactly once" is half the question this map answers.
 */
export const FREQUENCY_RAMP: Array<[number, number, number]> = [
  [56, 132, 255],
  [18, 221, 251],
  [163, 230, 53],
  [251, 191, 36],
  [244, 63, 94],
];

/** Five bands, matching RECENCY_BANDS one for one: fresh and bright to old and dim. */
export const RECENCY_COLORS: Array<[number, number, number]> = [
  [34, 211, 160],
  [163, 230, 53],
  [251, 191, 36],
  [249, 115, 22],
  [120, 113, 140],
];

function mixChannel(a: number, b: number, amount: number): number {
  return Math.round(a + (b - a) * amount);
}

/** A position 0..1 along a ramp, interpolated between its stops. */
export function rampAt(ramp: Array<[number, number, number]>, position: number): [number, number, number] {
  if (ramp.length === 0) return [255, 255, 255];
  const clamped = Math.max(0, Math.min(1, position));
  const scaled = clamped * (ramp.length - 1);
  const index = Math.min(ramp.length - 2, Math.floor(scaled));
  const within = scaled - index;
  const from = ramp[index];
  const to = ramp[Math.min(ramp.length - 1, index + 1)];

  return [
    mixChannel(from[0], to[0], within),
    mixChannel(from[1], to[1], within),
    mixChannel(from[2], to[2], within),
  ];
}

function paceMetersPerSecond(sample: NonNullable<GPXRoute["samples"]>[number]): number | null {
  if (typeof sample.paceMinPerKm !== "number" || sample.paceMinPerKm <= 0) return null;
  return 1 / sample.paceMinPerKm;
}

/**
 * The personal heatmap, drawn from counted ground.
 *
 * One canvas for every mode, because the modes differ only in which number a
 * segment is coloured by. Width is constant at every zoom and in every mode:
 * the moment thickness carries data, two neighbouring streets merge into a
 * blob and the reader loses both.
 *
 * The counting is not done here. It happens once, on a geographic grid, in
 * `@/engine/heatmap` — so "twelve runs down this road" stays twelve however
 * far you zoom, which a canvas accumulating pixels can never promise.
 */
function PersonalHeatmapCanvas({
  routes,
  enabled,
  mode,
  grid,
  stops,
  paceRange,
}: {
  routes: GPXRoute[];
  enabled: boolean;
  mode: PersonalHeatmapMode;
  grid: VisitGrid | null;
  stops: number[];
  paceRange: { min: number; max: number } | null;
}) {
  const map = useMap();

  useEffect(() => {
    if (!enabled || routes.length === 0 || !grid) return;

    const canvas = L.DomUtil.create("canvas", "leaflet-heatmap-canvas") as HTMLCanvasElement;
    canvas.style.position = "absolute";
    canvas.style.pointerEvents = "none";
    canvas.style.zIndex = "450";
    map.getPanes().overlayPane.appendChild(canvas);

    let frame = 0;
    const now = Date.now();

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
      // Constant, thin, and the same at every zoom. The data is in the colour.
      context.lineWidth = 2.4 * scale;

      // Off-screen work is the bulk of a long history, so segments outside the
      // viewport are dropped before any colour is computed for them.
      const margin = 60;
      const onScreen = (point: L.Point) =>
        point.x >= -margin && point.y >= -margin && point.x <= size.x + margin && point.y <= size.y + margin;

      for (const route of routes) {
        const coordinates = route.coordinates;
        if (!coordinates || coordinates.length < 2) continue;

        // Pace is the one metric that lives on the samples rather than on the
        // ground, and samples are stored downsampled — so it is read by
        // proportion along the track, never by index.
        const samples = mode === "pace" ? route.samples ?? [] : [];
        const sampleRatio = samples.length > 1 ? (samples.length - 1) / (coordinates.length - 1) : 0;

        for (let i = 1; i < coordinates.length; i += 1) {
          const from = map.latLngToContainerPoint([coordinates[i - 1][1], coordinates[i - 1][0]]);
          const to = map.latLngToContainerPoint([coordinates[i][1], coordinates[i][0]]);
          if (!onScreen(from) && !onScreen(to)) continue;

          const midpoint = {
            lat: (coordinates[i - 1][1] + coordinates[i][1]) / 2,
            lng: (coordinates[i - 1][0] + coordinates[i][0]) / 2,
          };

          const colour = segmentColour({ mode, grid, stops, paceRange, midpoint, samples, sampleRatio, index: i, now });
          if (!colour) continue;

          context.beginPath();
          context.moveTo(from.x * scale, from.y * scale);
          context.lineTo(to.x * scale, to.y * scale);
          context.strokeStyle = colour;
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
  }, [enabled, map, mode, routes, grid, stops, paceRange]);

  return null;
}

/**
 * The colour of one segment.
 *
 * Pulled out of the draw loop so the three modes sit side by side and can be
 * compared: each one turns a number into a position on a ramp, and nothing
 * else. Ground with no number to show is skipped rather than drawn in a
 * default colour that would read as data.
 */
function segmentColour(input: {
  mode: PersonalHeatmapMode;
  grid: VisitGrid;
  stops: number[];
  paceRange: { min: number; max: number } | null;
  midpoint: { lat: number; lng: number };
  samples: NonNullable<GPXRoute["samples"]>;
  sampleRatio: number;
  index: number;
  now: number;
}): string | null {
  const { mode, grid, stops, paceRange, midpoint, samples, sampleRatio, index, now } = input;

  if (mode === "pace") {
    if (!paceRange || samples.length < 2) return null;
    const sample = samples[Math.min(samples.length - 1, Math.round(index * sampleRatio))];
    const speed = sample ? paceMetersPerSecond(sample) : null;
    if (speed === null) return null;

    const span = paceRange.max - paceRange.min;
    const position = span <= 0 ? 0.5 : (speed - paceRange.min) / span;
    const [r, g, b] = rampAt(FREQUENCY_RAMP, position);
    return `rgba(${r}, ${g}, ${b}, 0.85)`;
  }

  const cell = cellAt(grid, midpoint);
  if (!cell) return null;

  if (mode === "recency") {
    const [r, g, b] = RECENCY_COLORS[recencyBandIndex(daysSince(cell, now))];
    return `rgba(${r}, ${g}, ${b}, 0.85)`;
  }

  const position = frequencyPosition(cell.visits, stops);
  const [r, g, b] = rampAt(FREQUENCY_RAMP, position);
  // Ground run once stays clearly visible: it is half the question this map
  // answers, and fading it out was what made the old view unreadable.
  return `rgba(${r}, ${g}, ${b}, ${0.6 + position * 0.35})`;
}

function simplifyPositions(coords: [number, number][], maxPoints = 200): [number, number][] {
  if (coords.length <= maxPoints) return coords;
  const step = Math.ceil(coords.length / maxPoints);
  return coords.filter((_, i) => i % step === 0 || i === coords.length - 1);
}

export default function Map({
  routes,
  selectedRoute,
  showHeatmap,
  fitAllRoutes = false,
  showPersonalHeatmap = false,
  personalHeatmapMode = "frequency",
  heatmapGrid = null,
  heatmapStops = [],
  heatmapPaceRange = null,
  suggestedRoute,
  selectedStartPoint,
  onMapClick,
  isSelectingStartPoint,
  darkMode = true,
  familiaritySegments = [],
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

  const heatmapRoutes = useMemo(() => {
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
  }, [routes, selectedRoute, showHeatmap]);

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
      <BaseMapLayer darkMode={darkMode} />

      <MapController routes={routes} selectedRoute={selectedRoute} suggestedRoute={suggestedRoute ?? null} fitAllRoutes={fitAllRoutes} />
      <MapResizeHandler />
      <MapEvents onMapClick={onMapClick} />
      <RouteClusterMarkers routes={routes} enabled={!selectedRoute && !suggestedRoute && routes.length > 0} />
      <PersonalHeatmapCanvas
        routes={routes}
        enabled={showPersonalHeatmap && !selectedRoute && !suggestedRoute}
        mode={personalHeatmapMode}
        grid={heatmapGrid}
        stops={heatmapStops}
        paceRange={heatmapPaceRange}
      />

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
      {heatmapRoutes.map((route, index) => (
        <Polyline
          key={`heatmap-${index}`}
          positions={route.positions}
          pathOptions={{ color: route.color, weight: route.weight, opacity: route.opacity }}
        />
      ))}

      {familiaritySegments.map((segment, index) => {
        const color =
          segment.label === "familiar"
            ? "#16a34a"
            : segment.label === "partly familiar"
              ? "#f59e0b"
              : "#f97316";

        return (
          <Polyline
            key={`familiarity-${index}`}
            positions={segment.coordinates.map(([lon, lat]) => [lat, lon] as [number, number])}
            pathOptions={{ color, weight: 7, opacity: 0.95 }}
          />
        );
      })}

    </MapContainer>
  );
}
