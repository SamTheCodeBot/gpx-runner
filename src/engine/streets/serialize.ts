import { LatLng } from "../../types";
import type { Street } from "./inventory";
import type { StreetScope } from "./scope";

/**
 * Wire and storage form for a street list.
 *
 * A town-sized snapshot is hundreds of streets and tens of thousands of
 * coordinates, and it has to survive a Firestore document, a JSON response and
 * a browser cache. Coordinates go over as flat number arrays at five decimals —
 * about a metre, against a matching corridor of sixteen — which roughly halves
 * the payload compared with `{lat,lng}` objects while changing no answer the
 * engine gives.
 */

const PRECISION = 5;

export type WireStreet = {
  id: string;
  name: string;
  part: number;
  wayIds: number[];
  lengthMeters: number;
  /** Each piece is [lat, lng, lat, lng, ...]. */
  geometry: number[][];
};

export type WireSnapshot = {
  takenAt: string;
  totalMeters: number;
  streets: WireStreet[];
};

export type WireScope = {
  ring: number[];
  source: StreetScope["source"];
};

function round(value: number): number {
  return Number(value.toFixed(PRECISION));
}

export function encodeStreet(street: Street): WireStreet {
  return {
    id: street.id,
    name: street.name,
    part: street.part,
    wayIds: street.wayIds,
    lengthMeters: Math.round(street.lengthMeters * 10) / 10,
    geometry: street.geometry.map((piece) => piece.flatMap((point) => [round(point.lat), round(point.lng)])),
  };
}

export function decodeStreet(wire: WireStreet): Street {
  return {
    id: wire.id,
    name: wire.name,
    part: wire.part ?? 0,
    wayIds: Array.isArray(wire.wayIds) ? wire.wayIds : [],
    lengthMeters: wire.lengthMeters ?? 0,
    geometry: (wire.geometry ?? []).map(decodePiece).filter((piece) => piece.length >= 2),
  };
}

function decodePiece(flat: number[]): LatLng[] {
  const points: LatLng[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) points.push({ lat: flat[i], lng: flat[i + 1] });
  return points;
}

export function encodeStreets(streets: Street[]): WireStreet[] {
  return streets.map(encodeStreet);
}

export function decodeStreets(wire: WireStreet[] | undefined): Street[] {
  if (!Array.isArray(wire)) return [];
  return wire.map(decodeStreet).filter((street) => street.geometry.length > 0);
}

export function encodeScope(scope: StreetScope): WireScope {
  return {
    ring: scope.ring.flatMap((point) => [round(point.lat), round(point.lng)]),
    source: scope.source,
  };
}

export function decodeScope(wire: WireScope): StreetScope {
  return { ring: decodePiece(wire.ring ?? []), source: wire.source };
}

/**
 * Split a street list into chunks that each fit a Firestore document.
 *
 * Sized by encoded bytes rather than by street count: a snapshot is mostly
 * geometry, and one long coastal road can outweigh fifty cul-de-sacs.
 */
export function chunkStreets(streets: WireStreet[], maxBytes = 600_000): WireStreet[][] {
  const chunks: WireStreet[][] = [];
  let current: WireStreet[] = [];
  let currentBytes = 0;

  for (const street of streets) {
    const bytes = JSON.stringify(street).length;
    if (current.length > 0 && currentBytes + bytes > maxBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(street);
    currentBytes += bytes;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}
