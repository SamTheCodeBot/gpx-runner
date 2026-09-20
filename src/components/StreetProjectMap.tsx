"use client";

import { useEffect, useMemo, useRef } from "react";
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
 *
 * Four layers, bottom to top: every street in the project, the ones ticked for
 * a route, the route itself, and the one street he is looking at. The last of
 * those is drawn green for what he has run and red for what he has not, which
 * is the only place on the map where red means anything.
 */

const canvasRenderer = L.canvas({ padding: 0.4 });

export type StreetLines = {
  covered: LatLng[][];
  missing: LatLng[][];
};

interface StreetProjectMapProps {
  ring: LatLng[];
  lines?: StreetLines;
  /**
   * Streets the owner has struck off, drawn muted rather than removed.
   *
   * They have to stay on the map to be put back: an excluded street that
   * vanishes can only be undone from a list, and the reason he excluded it was
   * something he saw on the map. Muted and dashed reads as "not part of this"
   * without competing with the red he is actually hunting.
   */
  excluded?: LatLng[][];
  /** Ticked for a route, so the list's checkboxes are visible on the map. */
  checked?: LatLng[][];
  /**
   * Framed by the map, never drawn by it.
   *
   * Separate from `focusLines` because what the map should fly to and what the
   * map should colour are two different questions with two different answers:
   * a street picked out of the list wants both, a street picked off the map is
   * already on screen and wants only the second.
   */
  focus?: LatLng[][];
  /** The picked street in green and red: what he has run, what he has not. */
  focusLines?: StreetLines;
  /** A built route through the ticked streets, drawn over the lot. */
  route?: LatLng[];
  pin?: LatLng | null;
  onMapClick?: (lat: number, lng: number, toleranceMeters: number) => void;
  fitKey?: string;
  darkMode?: boolean;
}

function toLeaflet(points: LatLng[]): [number, number][] {
  return points.map((point) => [point.lat, point.lng]);
}

/**
 * How wide of the mark a click may be and still mean a street.
 *
 * In pixels, because that is the unit a finger is aimed in. Converted to metres
 * against the current zoom before it leaves here: forty metres is a
 * neighbouring street when you are zoomed in on one road and less than a pixel
 * when you are looking at the whole town, and a fixed distance would be wrong
 * at one end or the other.
 */
const CLICK_SLOP_PIXELS = 18;
const MIN_CLICK_TOLERANCE_METERS = 12;
const MAX_CLICK_TOLERANCE_METERS = 120;

function ClickCatcher({ onMapClick }: { onMapClick?: (lat: number, lng: number, toleranceMeters: number) => void }) {
  const map = useMapEvents({
    click: (event) => {
      if (!onMapClick) return;
      const offset = map.containerPointToLatLng(event.containerPoint.add(L.point(CLICK_SLOP_PIXELS, 0)));
      const tolerance = Math.max(
        MIN_CLICK_TOLERANCE_METERS,
        Math.min(MAX_CLICK_TOLERANCE_METERS, map.distance(event.latlng, offset)),
      );
      onMapClick(event.latlng.lat, event.latlng.lng, tolerance);
    },
  });
  return null;
}

/** Zoomed in on one short street, this keeps enough town around it to place it. */
const FOCUS_MAX_ZOOM = 17;

/**
 * Frames whatever is being looked at: one street when the list has picked one,
 * the whole project otherwise.
 *
 * The same bargain the routes map makes — selecting a route flies to it,
 * dropping the selection returns to the overview — so the two lists feel like
 * the same gesture rather than two features that happen to both use Leaflet.
 */
function FitToTarget({
  ring,
  focus,
  route,
  fitKey,
}: {
  ring: LatLng[];
  focus?: LatLng[][];
  route?: LatLng[];
  fitKey?: string;
}) {
  const map = useMap();
  const lastFitKeyRef = useRef<string | null>(null);

  useEffect(() => {
    // A street picked from the list outranks a route on the map: the click is
    // the more recent statement of what he is looking at.
    const focusPoints = (focus ?? []).flat();
    const subject =
      focusPoints.length >= 2
        ? ("focus" as const)
        : (route?.length ?? 0) >= 2
          ? ("route" as const)
          : ("ring" as const);
    const focused = subject === "focus";
    const target = subject === "focus" ? focusPoints : subject === "route" ? route! : ring.length >= 3 ? ring : [];
    if (target.length === 0) return;

    // Composed with what is being framed, so clearing a street refits to the
    // project even though the caller's key has returned to a value it has
    // already used once.
    const key = `${fitKey ?? ""}|${subject}`;
    if (lastFitKeyRef.current === key) return;
    lastFitKeyRef.current = key;

    map.fitBounds(L.latLngBounds(toLeaflet(target)), {
      padding: focused ? [60, 60] : [24, 24],
      maxZoom: focused ? FOCUS_MAX_ZOOM : undefined,
    });
    // `fitKey` lets the caller decide when a refit is wanted: dragging a radius
    // slider should reframe, panning the map by hand should not.
  }, [map, fitKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

export default function StreetProjectMap({
  ring,
  lines,
  excluded,
  checked,
  focus,
  focusLines,
  route,
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
      <FitToTarget ring={ring} focus={focus} route={route} fitKey={fitKey} />

      {ring.length >= 3 && (
        <Polygon
          positions={toLeaflet(ring)}
          pathOptions={{ color: "rgb(255 65 164)", weight: 2, fillOpacity: 0.04, dashArray: "6 6" }}
        />
      )}

      {/* Struck off, and drawn first so everything that still counts sits on
          top of it. Dashed, thin and half transparent: present enough to click,
          quiet enough that it stops reading as a chore. */}
      {excluded?.map((piece, index) => (
        <Polyline
          key={`excluded-${index}`}
          positions={toLeaflet(piece)}
          pathOptions={{ color: "#8a8a8a", weight: 1.5, opacity: 0.45, dashArray: "4 5" }}
        />
      ))}

      {/* Unrun streets were slate grey, which vanished into a grey basemap.
          Red says "still to do" and survives both light and dark tiles. */}
      {lines?.missing.map((piece, index) => (
        <Polyline
          key={`missing-${index}`}
          positions={toLeaflet(piece)}
          pathOptions={{ color: "#ee5c5c", weight: 2, opacity: 0.9 }}
        />
      ))}

      {lines?.covered.map((piece, index) => (
        <Polyline
          key={`covered-${index}`}
          positions={toLeaflet(piece)}
          pathOptions={{ color: "rgb(34 197 94)", weight: 2.5, opacity: 0.95 }}
        />
      ))}

      {/* Ticked streets, in the colour of the checkbox that ticked them. */}
      {checked?.map((piece, index) => (
        <Polyline
          key={`checked-${index}`}
          positions={toLeaflet(piece)}
          pathOptions={{ color: "rgb(255 65 164)", weight: 3.5, opacity: 0.95 }}
        />
      ))}

      {route && route.length >= 2 && (
        <>
          {/* A casing under the line so it reads over green streets too. */}
          <Polyline
            positions={toLeaflet(route)}
            pathOptions={{ color: "#ffffff", weight: 7, opacity: 0.9 }}
          />
          <Polyline
            positions={toLeaflet(route)}
            pathOptions={{ color: "rgb(197 45 255)", weight: 3.5, opacity: 1 }}
          />
        </>
      )}

      {/* The picked street: a white casing so it reads out of a town of lines,
          then green for the part he has run and red for the part he has not.
          Drawn last, over everything, because it is the thing he just asked
          about. */}
      {focusLines &&
        [...focusLines.covered, ...focusLines.missing].map((piece, index) => (
          <Polyline
            key={`focus-casing-${index}`}
            positions={toLeaflet(piece)}
            pathOptions={{ color: "#ffffff", weight: 7, opacity: 0.85 }}
          />
        ))}

      {focusLines?.covered.map((piece, index) => (
        <Polyline
          key={`focus-covered-${index}`}
          positions={toLeaflet(piece)}
          pathOptions={{ color: "rgb(34 197 94)", weight: 4, opacity: 1 }}
        />
      ))}

      {focusLines?.missing.map((piece, index) => (
        <Polyline
          key={`focus-missing-${index}`}
          positions={toLeaflet(piece)}
          pathOptions={{ color: "rgb(239 68 68)", weight: 4, opacity: 1 }}
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
