"use client";

import { useEffect, useRef, useState } from "react";
import { TileLayer, useMap } from "react-leaflet";
import type L from "leaflet";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  getRasterAttribution,
  getRasterTileUrl,
  getVectorAttribution,
  getVectorStyleUrl,
} from "@/lib/basemap";

function hasWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(
      canvas.getContext("webgl2") ||
        canvas.getContext("webgl") ||
        canvas.getContext("experimental-webgl")
    );
  } catch {
    return false;
  }
}

interface BaseMapLayerProps {
  darkMode: boolean;
}

/**
 * Renders the basemap underneath the route overlays.
 *
 * Prefers the OpenFreeMap vector style (no API key, no watermark) rendered via
 * MapLibre inside Leaflet, and falls back to raster tiles when WebGL or the
 * vector style is unavailable.
 */
export default function BaseMapLayer({ darkMode }: BaseMapLayerProps) {
  const map = useMap();
  const styleUrl = getVectorStyleUrl(darkMode);
  const [useRaster, setUseRaster] = useState(() => !styleUrl);
  const layerRef = useRef<L.Layer | null>(null);

  useEffect(() => {
    if (!styleUrl) {
      setUseRaster(true);
      return;
    }
    if (!hasWebGL()) {
      setUseRaster(true);
      return;
    }

    let cancelled = false;
    let layer: L.Layer | null = null;

    (async () => {
      try {
        const [{ default: leaflet }, maplibregl] = await Promise.all([
          import("leaflet"),
          import("maplibre-gl"),
        ]);
        await import("@maplibre/maplibre-gl-leaflet");
        if (cancelled) return;

        layer = (leaflet as unknown as typeof L).maplibreGL({
          style: styleUrl,
          attribution: getVectorAttribution(),
          // Leaflet owns all interaction; MapLibre only paints the basemap.
          interactive: false,
          maplibreLogo: false,
          attributionControl: false,
        } as unknown as Parameters<typeof L.maplibreGL>[0]);

        const glMap = (layer as unknown as { getMaplibreMap: () => { on: (e: string, cb: () => void) => void } })
          .getMaplibreMap?.();
        glMap?.on("error", () => {
          if (!cancelled) setUseRaster(true);
        });

        layer.addTo(map);
        layerRef.current = layer;
        setUseRaster(false);
      } catch (err) {
        console.warn("[basemap] vector basemap unavailable, falling back to raster tiles", err);
        if (!cancelled) setUseRaster(true);
      }
    })();

    return () => {
      cancelled = true;
      const active = layerRef.current ?? layer;
      if (active) {
        try {
          map.removeLayer(active);
        } catch {
          /* map already torn down */
        }
      }
      layerRef.current = null;
    };
  }, [map, styleUrl]);

  if (!useRaster) return null;

  return (
    <TileLayer
      attribution={getRasterAttribution()}
      url={getRasterTileUrl(darkMode)}
      maxZoom={19}
      className={darkMode ? "basemap-raster-dark" : undefined}
    />
  );
}
