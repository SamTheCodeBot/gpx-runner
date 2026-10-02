"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { GPXRoute, RouteSuggestion } from "@/app/types";
import {
  cellAt,
  daysSince,
  frequencyPosition,
  recencyBandIndex,
  type VisitGrid,
} from "@/engine/heatmap";
import type { RouteFamiliaritySegment } from "@/lib/routeFamiliarity";
import {
  getRasterAttribution,
  getRasterFilterClass,
  getRasterTileUrl,
  getVectorAttribution,
  getVectorStyleUrl,
} from "@/lib/basemap";

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

function hasWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(
      canvas.getContext("webgl2") || canvas.getContext("webgl") || canvas.getContext("experimental-webgl")
    );
  } catch {
    return false;
  }
}

/** Plain-raster MapLibre style: one raster source, one raster layer. Used as
 * the default basemap and as the fallback if a vector style fails. */
function buildRasterStyle(darkMode: boolean): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {
      raster: {
        type: "raster",
        tiles: [getRasterTileUrl(darkMode)],
        tileSize: 256,
        attribution: getRasterAttribution(),
      },
    },
    layers: [{ id: "raster", type: "raster", source: "raster" }],
  };
}

function boundsOf(coords: [number, number][]): maplibregl.LngLatBoundsLike | null {
  if (coords.length === 0) return null;
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const [lon, lat] of coords) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return [[minLon, minLat], [maxLon, maxLat]];
}

const EMPTY_FC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

function lineFC(lines: Array<{ coords: [number, number][]; props?: Record<string, unknown> }>): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: lines
      .filter((l) => l.coords.length > 1)
      .map((l) => ({
        type: "Feature",
        properties: l.props ?? {},
        geometry: { type: "LineString", coordinates: l.coords },
      })),
  };
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
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);
  const [webglOk] = useState(() => typeof window !== "undefined" && hasWebGL());
  const lastFitKeyRef = useRef<string | null>(null);
  const clusterMarkersRef = useRef<maplibregl.Marker[]>([]);
  const kmMarkersRef = useRef<maplibregl.Marker[]>([]);
  const startMarkerRef = useRef<maplibregl.Marker | null>(null);
  const heatmapCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const onMapClickRef = useRef(onMapClick);
  onMapClickRef.current = onMapClick;

  const getCenter = (): [number, number] => {
    // [lon, lat] — MapLibre order.
    if (suggestedRoute && suggestedRoute.coordinates.length > 0) {
      const coords = suggestedRoute.coordinates;
      return [
        coords.reduce((sum, [lon]) => sum + lon, 0) / coords.length,
        coords.reduce((sum, [, lat]) => sum + lat, 0) / coords.length,
      ];
    }
    if (routes.length === 0) return [18.0686, 59.3293];
    const allCoords = routes.flatMap((r) => r.coordinates);
    if (allCoords.length === 0) return [18.0686, 59.3293];
    return [
      allCoords.reduce((sum, [lon]) => sum + lon, 0) / allCoords.length,
      allCoords.reduce((sum, [, lat]) => sum + lat, 0) / allCoords.length,
    ];
  };

  // ── Map init (once) ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || !webglOk) return;

    const styleUrl = getVectorStyleUrl(darkMode);
    const usingRaster = !styleUrl;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleUrl ?? buildRasterStyle(darkMode),
      center: getCenter(),
      zoom: 12,
      attributionControl: false,
    });
    mapRef.current = map;

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    let attributionControl: maplibregl.AttributionControl | null = null;
    const setAttribution = (text: string) => {
      if (attributionControl) map.removeControl(attributionControl);
      attributionControl = new maplibregl.AttributionControl({ compact: true, customAttribution: text });
      map.addControl(attributionControl, "bottom-right");
    };

    const applyRasterFilter = () => {
      const cls = getRasterFilterClass(darkMode);
      const canvas = map.getCanvas();
      canvas.classList.remove("basemap-raster-muted", "basemap-raster-dark");
      if (cls) canvas.classList.add(cls);
    };

    if (usingRaster) {
      applyRasterFilter();
      setAttribution(getRasterAttribution());
    } else {
      setAttribution(getVectorAttribution());
    }

    let fellBack = false;
    const fallbackToRaster = (reason: string, detail?: unknown) => {
      if (fellBack || !styleUrl) return;
      fellBack = true;
      console.warn(`[basemap] falling back to raster tiles: ${reason}`, detail ?? "");
      if (fallbackTimer) clearTimeout(fallbackTimer);
      // setStyle() throws away every custom source/layer the app added
      // (routes/suggested/familiarity lines) unless called with {diff:true}.
      // Drop `ready` to false across the swap and only flip it back once the
      // new style has actually finished loading, so every `[ready, ...]`
      // effect below re-creates its sources/layers and re-pushes current
      // data instead of leaving the map with markers but no lines.
      setReady(false);
      map.setStyle(buildRasterStyle(darkMode));
      const onFallbackStyleData = () => {
        if (!map.isStyleLoaded()) return;
        map.off("styledata", onFallbackStyleData);
        applyRasterFilter();
        setAttribution(getRasterAttribution());
        setReady(true);
      };
      map.on("styledata", onFallbackStyleData);
    };

    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    if (styleUrl) {
      fallbackTimer = setTimeout(() => fallbackToRaster("vector style timed out"), 6000);
      map.once("load", () => {
        if (fallbackTimer) clearTimeout(fallbackTimer);
      });
      map.on("error", (event: { error?: unknown }) => fallbackToRaster("vector style error", event?.error ?? event));
    }

    map.on("click", (e: maplibregl.MapMouseEvent) => onMapClickRef.current?.(e.lngLat.lat, e.lngLat.lng));
    map.on("load", () => setReady(true));

    return () => {
      if (fallbackTimer) clearTimeout(fallbackTimer);
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
    // Base style only depends on darkMode; everything else is drawn on top
    // once the map exists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [darkMode, webglOk]);

  // ── Resize ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    const container = containerRef.current;
    if (!map || !container || !ready) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => map.resize());
    });
    observer.observe(container);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [ready]);

  // ── Dragging toggle for start-point selection ───────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (isSelectingStartPoint) map.dragPan.disable();
    else map.dragPan.enable();
  }, [isSelectingStartPoint, ready]);

  // ── Route line sources/layers ────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const ensureSource = (id: string) => {
      if (!map.getSource(id)) {
        map.addSource(id, { type: "geojson", data: EMPTY_FC });
      }
    };
    const ensureLineLayer = (id: string, sourceId: string, paint: maplibregl.LineLayerSpecification["paint"], beforeId?: string) => {
      if (!map.getLayer(id)) {
        map.addLayer(
          { id, type: "line", source: sourceId, layout: { "line-cap": "round", "line-join": "round" }, paint },
          beforeId
        );
      }
    };

    ensureSource("routes");
    ensureLineLayer("routes-layer", "routes", {
      "line-color": ["get", "color"],
      "line-width": ["get", "weight"],
      "line-opacity": ["get", "opacity"],
    });

    ensureSource("suggested");
    ensureLineLayer("suggested-layer", "suggested", {
      "line-color": "#f472b6",
      "line-width": 5,
      "line-opacity": 1,
    });

    ensureSource("familiarity");
    ensureLineLayer("familiarity-layer", "familiarity", {
      "line-color": ["get", "color"],
      "line-width": 7,
      "line-opacity": 0.95,
    });

    return () => {
      // Layers/sources are torn down implicitly when the map itself is
      // removed (init effect above); nothing to do on prop changes.
    };
  }, [ready]);

  // Route polylines (heatmap-style route overview)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const source = map.getSource("routes") as maplibregl.GeoJSONSource | undefined;
    if (!source) return;

    // A route picked from the list is its own thing to draw, independent of
    // whatever the overview collection currently holds — an empty or
    // still-loading `routes` array must never erase the one line the owner
    // just asked to see by clicking it.
    if (!showHeatmap || (routes.length === 0 && !selectedRoute)) {
      source.setData(EMPTY_FC);
      return;
    }

    const colorFor = (type?: string) =>
      type === "trail" ? "rgb(18 221 251)" : type === "mixed" ? "rgb(197 45 255)" : "rgb(255 65 164)";

    const lines = selectedRoute
      ? [{ coords: simplifyPositions(selectedRoute.coordinates, 500), props: { color: colorFor(selectedRoute.type), weight: 4, opacity: 1 } }]
      : routes.map((route) => ({
          coords: simplifyPositions(route.coordinates, 500),
          props: { color: colorFor(route.type), weight: 1.5, opacity: 0.5 },
        }));

    source.setData(lineFC(lines));
  }, [ready, routes, selectedRoute, showHeatmap]);

  // Suggested route
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const source = map.getSource("suggested") as maplibregl.GeoJSONSource | undefined;
    if (!source) return;
    if (suggestedRoute && suggestedRoute.coordinates.length > 0) {
      source.setData(lineFC([{ coords: suggestedRoute.coordinates }]));
    } else {
      source.setData(EMPTY_FC);
    }
  }, [ready, suggestedRoute]);

  // Familiarity segments
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const source = map.getSource("familiarity") as maplibregl.GeoJSONSource | undefined;
    if (!source) return;
    const lines = familiaritySegments.map((segment) => ({
      coords: segment.coordinates,
      props: {
        color: segment.label === "familiar" ? "#16a34a" : segment.label === "partly familiar" ? "#f59e0b" : "#f97316",
      },
    }));
    source.setData(lineFC(lines));
  }, [ready, familiaritySegments]);

  // ── fitBounds ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

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
      // Cluster on the median-distance-from-centroid trick, same as before:
      // drop outlier routes (e.g. one trip abroad) so the default view stays
      // on home turf instead of zooming out to fit everything.
      const toRad = (d: number) => (d * Math.PI) / 180;
      const R = 6371;
      const kmDist = (lat1: number, lon1: number, lat2: number, lon2: number) => {
        const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
          Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      };

      let clusterRoutes = [...routes];
      for (let iter = 0; iter < 4; iter++) {
        const centroids = clusterRoutes.map(routeCentroid).filter((c): c is [number, number] => !!c);
        if (centroids.length === 0) break;
        const cenLon = centroids.reduce((s, c) => s + c[0], 0) / centroids.length;
        const cenLat = centroids.reduce((s, c) => s + c[1], 0) / centroids.length;
        const sorted = clusterRoutes
          .map((r) => {
            const c = routeCentroid(r);
            return { r, d: c ? kmDist(c[1], c[0], cenLat, cenLon) : Infinity };
          })
          .sort((a, b) => a.d - b.d);
        const mid = Math.floor(sorted.length / 2);
        const medianDist = sorted[mid].d;
        clusterRoutes = sorted.filter((x) => x.d <= medianDist * 2.5).map((x) => x.r);
        if (clusterRoutes.length <= 1) break;
      }
      if (clusterRoutes.length < 2) clusterRoutes = routes;

      const bounds = boundsOf(clusterRoutes.flatMap((r) => r.coordinates));
      if (bounds) map.fitBounds(bounds, { padding: 50, animate: false });
    } else {
      const bounds = boundsOf(targetCoords);
      if (bounds) map.fitBounds(bounds, { padding: 50, animate: false });
    }
    lastFitKeyRef.current = fitKey;
  }, [ready, routes, selectedRoute, suggestedRoute, fitAllRoutes]);

  // ── Start point marker ──────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    startMarkerRef.current?.remove();
    startMarkerRef.current = null;
    if (!selectedStartPoint) return;

    const el = document.createElement("div");
    el.style.cssText = `background:#22d3ee;border:3px solid ${darkMode ? "#0a0a0b" : "#ffffff"};border-radius:50%;width:30px;height:30px;display:flex;align-items:center;justify-content:center;font-size:16px;box-shadow:0 0 10px rgba(34,211,238,0.5);`;
    el.textContent = "🏃";
    startMarkerRef.current = new maplibregl.Marker({ element: el })
      .setLngLat([selectedStartPoint[0], selectedStartPoint[1]])
      .setPopup(new maplibregl.Popup({ offset: 18 }).setText("Start/End Point"))
      .addTo(map);
  }, [ready, selectedStartPoint, darkMode]);

  // ── Kilometer markers ────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    kmMarkersRef.current.forEach((m) => m.remove());
    kmMarkersRef.current = [];

    const activeRouteCoords = selectedRoute?.coordinates || suggestedRoute?.coordinates || [];
    const kmMarkers = getKilometerMarkers(activeRouteCoords);

    kmMarkersRef.current = kmMarkers.map(({ position, km }) => {
      const el = document.createElement("div");
      el.style.cssText = `background:${darkMode ? "#18181b" : "#ffffff"};border:2px solid ${darkMode ? "#22d3ee" : "#0891b2"};border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:bold;color:${darkMode ? "#22d3ee" : "#0891b2"};box-shadow:0 2px 4px rgba(0,0,0,0.3);`;
      el.textContent = String(km);
      return new maplibregl.Marker({ element: el })
        .setLngLat(position)
        .setPopup(new maplibregl.Popup({ offset: 14 }).setText(`${km} km`))
        .addTo(map);
    });

    return () => {
      kmMarkersRef.current.forEach((m) => m.remove());
      kmMarkersRef.current = [];
    };
  }, [ready, selectedRoute, suggestedRoute, darkMode]);

  // ── Route cluster markers (low zoom, "N routes here" pins) ──────────────
  const clusterEnabled = !selectedRoute && !suggestedRoute && routes.length > 0;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const clearMarkers = () => {
      clusterMarkersRef.current.forEach((m) => m.remove());
      clusterMarkersRef.current = [];
    };

    const update = () => {
      clearMarkers();
      if (!clusterEnabled || map.getZoom() >= 9) return;

      const clusterDistancePx = map.getZoom() <= 5 ? 78 : 58;
      const clusters: Array<{ routes: GPXRoute[]; lng: number; lat: number; x: number; y: number }> = [];

      for (const route of routes) {
        const centroid = routeCentroid(route);
        if (!centroid) continue;
        const [lng, lat] = centroid;
        const point = map.project([lng, lat]);
        const existing = clusters.find((cluster) => {
          const dx = cluster.x - point.x;
          const dy = cluster.y - point.y;
          return Math.sqrt(dx * dx + dy * dy) <= clusterDistancePx;
        });
        if (existing) {
          existing.routes.push(route);
          existing.lng = existing.routes.reduce((sum, item) => sum + (routeCentroid(item)?.[0] ?? 0), 0) / existing.routes.length;
          existing.lat = existing.routes.reduce((sum, item) => sum + (routeCentroid(item)?.[1] ?? 0), 0) / existing.routes.length;
          const nextPoint = map.project([existing.lng, existing.lat]);
          existing.x = nextPoint.x;
          existing.y = nextPoint.y;
        } else {
          clusters.push({ routes: [route], lng, lat, x: point.x, y: point.y });
        }
      }

      clusterMarkersRef.current = clusters.map((cluster) => {
        const routeCount = cluster.routes.length;
        const el = document.createElement("div");
        el.style.cssText = "width:34px;height:34px;border-radius:999px;display:flex;align-items:center;justify-content:center;background:rgb(255 65 164);color:white;border:3px solid white;font-size:13px;font-weight:900;box-shadow:0 4px 14px rgba(0,0,0,0.28);cursor:pointer;";
        el.textContent = String(routeCount);
        el.addEventListener("click", () => {
          const coords = cluster.routes.flatMap((route) => route.coordinates);
          const bounds = boundsOf(coords);
          if (bounds) map.fitBounds(bounds, { padding: 70 });
        });
        const marker = new maplibregl.Marker({ element: el }).setLngLat([cluster.lng, cluster.lat]);
        if (routeCount === 1) {
          marker.setPopup(new maplibregl.Popup({ offset: 18 }).setText(cluster.routes[0].name));
        } else {
          marker.setPopup(new maplibregl.Popup({ offset: 18 }).setText(`${routeCount} routes in this area`));
        }
        marker.addTo(map);
        return marker;
      });
    };

    update();
    map.on("moveend", update);
    map.on("zoomend", update);
    return () => {
      map.off("moveend", update);
      map.off("zoomend", update);
      clearMarkers();
    };
  }, [ready, routes, clusterEnabled]);

  // ── Personal heatmap canvas overlay ──────────────────────────────────────
  const heatmapEnabled = showPersonalHeatmap && !selectedRoute && !suggestedRoute;
  useEffect(() => {
    const map = mapRef.current;
    const container = containerRef.current;
    if (!map || !container || !ready || !heatmapEnabled || routes.length === 0 || !heatmapGrid) {
      heatmapCanvasRef.current?.remove();
      heatmapCanvasRef.current = null;
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.style.position = "absolute";
    canvas.style.top = "0";
    canvas.style.left = "0";
    canvas.style.pointerEvents = "none";
    canvas.style.zIndex = "5";
    container.appendChild(canvas);
    heatmapCanvasRef.current = canvas;

    let frame = 0;
    const now = Date.now();
    const grid = heatmapGrid;

    const draw = () => {
      const rect = container.getBoundingClientRect();
      const scale = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      canvas.width = Math.max(1, Math.round(rect.width * scale));
      canvas.height = Math.max(1, Math.round(rect.height * scale));

      const context = canvas.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.lineCap = "round";
      context.lineJoin = "round";
      context.lineWidth = 2.4 * scale;

      const margin = 60;
      const onScreen = (p: { x: number; y: number }) =>
        p.x >= -margin && p.y >= -margin && p.x <= rect.width + margin && p.y <= rect.height + margin;

      for (const route of routes) {
        const coordinates = route.coordinates;
        if (!coordinates || coordinates.length < 2) continue;

        const samples = personalHeatmapMode === "pace" ? route.samples ?? [] : [];
        const sampleRatio = samples.length > 1 ? (samples.length - 1) / (coordinates.length - 1) : 0;

        for (let i = 1; i < coordinates.length; i += 1) {
          const from = map.project(coordinates[i - 1]);
          const to = map.project(coordinates[i]);
          if (!onScreen(from) && !onScreen(to)) continue;

          const midpoint = {
            lat: (coordinates[i - 1][1] + coordinates[i][1]) / 2,
            lng: (coordinates[i - 1][0] + coordinates[i][0]) / 2,
          };

          const colour = segmentColour({
            mode: personalHeatmapMode,
            grid,
            stops: heatmapStops,
            paceRange: heatmapPaceRange,
            midpoint,
            samples,
            sampleRatio,
            index: i,
            now,
          });
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
    map.on("move", scheduleDraw);
    map.on("resize", scheduleDraw);

    return () => {
      window.cancelAnimationFrame(frame);
      map.off("move", scheduleDraw);
      map.off("resize", scheduleDraw);
      canvas.remove();
      if (heatmapCanvasRef.current === canvas) heatmapCanvasRef.current = null;
    };
    // heatmapStops/heatmapPaceRange are small arrays/objects recomputed
    // upstream each render; re-running the draw on every render of those is
    // fine since it's a cheap rAF-scheduled redraw, not a re-subscribe storm.
  }, [ready, heatmapEnabled, routes, personalHeatmapMode, heatmapGrid, heatmapStops, heatmapPaceRange]);

  if (!webglOk) {
    return (
      <div
        className="w-full h-full flex items-center justify-center text-center px-6"
        style={{ background: darkMode ? "#111113" : "#f4f4f5", color: darkMode ? "#a1a1aa" : "#52525b" }}
      >
        <p className="text-sm">
          Your browser doesn&apos;t support WebGL, which the map needs. Try a recent Chrome, Firefox or Safari.
        </p>
      </div>
    );
  }

  return <div ref={containerRef} style={{ height: "100%", width: "100%", background: darkMode ? "#111113" : "#f4f4f5" }} />;
}
