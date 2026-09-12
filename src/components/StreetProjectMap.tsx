"use client";

import { useEffect, useMemo } from "react";
import { MapContainer, Polygon, Polyline, CircleMarker, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";

import BaseMapLayer from "./BaseMapLayer";
import type { LatLng } from "@/types";

/**
 * The project on a map: the area, the streets done, the streets left.
 *
 * Deliberately dumb — it draws what it is handed. The split between covered and
 * missing comes from the same function that computes the percentage, so the
 * green on this map and the number above it can never disagree.
 */

const canvasRenderer = L.canvas({ padding: 0.4 });

export type StreetLines = {
  covered: LatLng[][];
  missing: LatLng[][];
};

interface StreetProjectMapProps {
  ring: LatLng[];
  lines?: StreetLines;
  /** Highlighted above everything else — a street picked from the list. */
  focus?: LatLng[][];
  pin?: LatLng | null;
  onMapClick?: (lat: number, lng: number) => void;
  fitKey?: string;
  darkMode?: boolean;
}

function toLeaflet(points: LatLng[]): [number, number][] {
  return points.map((point) => [point.lat, point.lng]);
}

function ClickCatcher({ onMapClick }: { onMapClick?: (lat: number, lng: number) => void }) {
  useMapEvents({
    click: (event) => onMapClick?.(event.latlng.lat, event.latlng.lng),
  });
  return null;
}

function FitToRing({ ring, fitKey }: { ring: LatLng[]; fitKey?: string }) {
  const map = useMap();

  useEffect(() => {
    if (ring.length < 3) return;
    const bounds = L.latLngBounds(toLeaflet(ring));
    map.fitBounds(bounds, { padding: [24, 24] });
    // `fitKey` lets the caller decide when a refit is wanted: dragging a radius
    // slider should reframe, panning the map by hand should not.
  }, [map, fitKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

export default function StreetProjectMap({
  ring,
  lines,
  focus,
  pin,
  onMapClick,
  fitKey,
  darkMode = false,
}: StreetProjectMapProps) {
  const center = useMemo<[number, number]>(() => {
    if (pin) return [pin.lat, pin.lng];
    if (ring.length === 0) return [56.907, 12.5072];
    const lat = ring.reduce((sum, point) => sum + point.lat, 0) / ring.length;
    const lng = ring.reduce((sum, point) => sum + point.lng, 0) / ring.length;
    return [lat, lng];
  }, [ring, pin]);

  return (
    <MapContainer
      center={center}
      zoom={13}
      className="w-full h-full"
      renderer={canvasRenderer}
      preferCanvas
      scrollWheelZoom
    >
      <BaseMapLayer darkMode={darkMode} />
      <ClickCatcher onMapClick={onMapClick} />
      <FitToRing ring={ring} fitKey={fitKey} />

      {ring.length >= 3 && (
        <Polygon
          positions={toLeaflet(ring)}
          pathOptions={{ color: "rgb(255 65 164)", weight: 2, fillOpacity: 0.04, dashArray: "6 6" }}
        />
      )}

      {lines?.missing.map((piece, index) => (
        <Polyline
          key={`missing-${index}`}
          positions={toLeaflet(piece)}
          pathOptions={{ color: "rgb(148 163 184)", weight: 3, opacity: 0.85 }}
        />
      ))}

      {lines?.covered.map((piece, index) => (
        <Polyline
          key={`covered-${index}`}
          positions={toLeaflet(piece)}
          pathOptions={{ color: "rgb(34 197 94)", weight: 4, opacity: 0.95 }}
        />
      ))}

      {focus?.map((piece, index) => (
        <Polyline
          key={`focus-${index}`}
          positions={toLeaflet(piece)}
          pathOptions={{ color: "rgb(255 65 164)", weight: 6, opacity: 1 }}
        />
      ))}

      {pin && (
        <CircleMarker
          center={[pin.lat, pin.lng]}
          radius={7}
          pathOptions={{ color: "#ffffff", weight: 2, fillColor: "rgb(255 65 164)", fillOpacity: 1 }}
        />
      )}
    </MapContainer>
  );
}
