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
  /**
   * Every point of every piece, flat: [lat, lng, lat, lng, ...].
   *
   * Flat because **Firestore refuses an array nested inside an array** — it
   * answers `INVALID_ARGUMENT: Property array contains an invalid nested
   * entity` and refuses the whole document. A street is naturally several
   * pieces, so the obvious `number[][]` cannot be stored at all; the run is
   * kept flat and `pieces` says where to cut it.
   */
  geometry: number[];
  /** Point count per piece, in order, so the flat run can be split back up. */
  pieces: number[];
};

/** The shape written before the Firestore nesting limit was discovered. */
type LegacyWireStreet = Omit<WireStreet, "geometry" | "pieces"> & { geometry: number[][]; pieces?: undefined };

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
  const geometry: number[] = [];
  const pieces: number[] = [];

  for (const piece of street.geometry) {
    if (piece.length < 2) continue;
    pieces.push(piece.length);
    for (const point of piece) geometry.push(round(point.lat), round(point.lng));
  }

  return {
    id: street.id,
    name: street.name,
    part: street.part,
    wayIds: street.wayIds,
    lengthMeters: Math.round(street.lengthMeters * 10) / 10,
    geometry,
    pieces,
  };
}

export function decodeStreet(wire: WireStreet | LegacyWireStreet): Street {
  return {
    id: wire.id,
    name: wire.name,
    part: wire.part ?? 0,
    wayIds: Array.isArray(wire.wayIds) ? wire.wayIds : [],
    lengthMeters: wire.lengthMeters ?? 0,
    geometry: decodeGeometry(wire).filter((piece) => piece.length >= 2),
  };
}

/** Reads both the flat form and anything written in the old nested form. */
function decodeGeometry(wire: WireStreet | LegacyWireStreet): LatLng[][] {
  const geometry = wire.geometry ?? [];
  if (geometry.length > 0 && Array.isArray(geometry[0])) {
    return (geometry as number[][]).map(decodePiece);
  }

  const flat = geometry as number[];
  const pieces = wire.pieces;
  if (!Array.isArray(pieces) || pieces.length === 0) {
    // No cut list: the whole run is one piece.
    return flat.length >= 4 ? [decodePiece(flat)] : [];
  }

  const out: LatLng[][] = [];
  let offset = 0;
  for (const count of pieces) {
    out.push(decodePiece(flat.slice(offset, offset + count * 2)));
    offset += count * 2;
  }
  return out;
}

function decodePiece(flat: number[]): LatLng[] {
  const points: LatLng[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) points.push({ lat: flat[i], lng: flat[i + 1] });
  return points;
}

export function encodeStreets(streets: Street[]): WireStreet[] {
  return streets.map(encodeStreet);
}

export function decodeStreets(wire: Array<WireStreet | LegacyWireStreet> | undefined): Street[] {
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
