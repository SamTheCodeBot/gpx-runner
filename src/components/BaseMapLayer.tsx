"use client";

import { useEffect, useRef, useState } from "react";
import { TileLayer, useMap } from "react-leaflet";
import type L from "leaflet";
import {
  getRasterAttribution,
  getRasterTileUrl,
  getVectorAttribution,
  getVectorStyleUrl,
  rasterHasDarkStyle,
} from "@/lib/basemap";

/** Minimal shape of the MapLibre map exposed by the Leaflet plugin. */
type GLMap = { on: (event: string, cb: (payload?: unknown) => void) => void };

/** How long the vector style gets to paint before we fall back to raster tiles. */
const VECTOR_LOAD_TIMEOUT_MS = 6000;

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
 * With the `openfreemap` provider it renders a MapLibre vector style inside
 * Leaflet; if WebGL is missing, the style errors, or nothing has painted after
 * VECTOR_LOAD_TIMEOUT_MS, it tears the vector layer down and shows raster tiles
 * instead, so the map is never left blank.
 */
export default function BaseMapLayer({ darkMode }: BaseMapLayerProps) {
  const map = useMap();
  const styleUrl = getVectorStyleUrl(darkMode);
  const [useRaster, setUseRaster] = useState(() => !styleUrl);

  useEffect(() => {
    if (!styleUrl || !hasWebGL()) {
      setUseRaster(true);
      return;
    }

    let cancelled = false;
    let layer: L.Layer | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const removeLayer = () => {
      if (!layer) return;
      try {
        map.removeLayer(layer);
      } catch {
        /* map already torn down */
      }
      layer = null;
    };

    const fallback = (reason: string, detail?: unknown) => {
      if (cancelled) return;
      console.warn(`[basemap] falling back to raster tiles: ${reason}`, detail ?? "");
      if (timer) clearTimeout(timer);
      timer = null;
      removeLayer();
      setUseRaster(true);
    };

    (async () => {
      try {
        const [{ default: leaflet }] = await Promise.all([
          import("leaflet"),
          import("maplibre-gl"),
        ]);
        await import("@maplibre/maplibre-gl-leaflet");
        if (cancelled) return;

        layer = (leaflet as unknown as typeof L).maplibreGL({
          style: styleUrl,
          attribution: getVectorAttribution(),
          interactive: false,
          attributionControl: false,
        } as unknown as Parameters<typeof L.maplibreGL>[0]);

        // The MapLibre map only exists once the layer has been added.
        layer.addTo(map);
        if (cancelled) {
          removeLayer();
          return;
        }

        const glMap = (
          layer as unknown as { getMaplibreMap?: () => GLMap | undefined }
        ).getMaplibreMap?.();

        if (!glMap) {
          fallback("MapLibre map was not created");
          return;
        }

        timer = setTimeout(() => fallback("vector style timed out"), VECTOR_LOAD_TIMEOUT_MS);

        glMap.on("load", () => {
          if (cancelled) return;
          if (timer) clearTimeout(timer);
          timer = null;
          setUseRaster(false);
        });

        glMap.on("error", (event: unknown) => {
          fallback("vector style error", (event as { error?: unknown })?.error ?? event);
        });
      } catch (err) {
        fallback("vector basemap failed to initialise", err);
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      removeLayer();
    };
  }, [map, styleUrl]);

  if (!useRaster) return null;

  return (
    <TileLayer
      attribution={getRasterAttribution()}
      url={getRasterTileUrl(darkMode)}
      maxZoom={19}
      className={darkMode && !rasterHasDarkStyle() ? "basemap-raster-dark" : undefined}
    />
  );
}
