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

/**
 * Flatten any list of pieces into the `{geometry, pieces}` pair Firestore can
 * hold — shared by streets and by the segments struck off one at a time,
 * because both are "a few disconnected runs of coordinates" and Firestore's
 * ban on nested arrays does not care which.
 */
export function encodePieces(pieces: LatLng[][]): { geometry: number[]; pieces: number[] } {
  const geometry: number[] = [];
  const counts: number[] = [];

  for (const piece of pieces) {
    if (piece.length < 2) continue;
    counts.push(piece.length);
    for (const point of piece) geometry.push(round(point.lat), round(point.lng));
  }

  return { geometry, pieces: counts };
}

export function decodePieces(wire: { geometry?: number[]; pieces?: number[] }): LatLng[][] {
  const flat = wire.geometry ?? [];
  const counts = wire.pieces;
  if (!Array.isArray(counts) || counts.length === 0) {
    return flat.length >= 4 ? [decodePiece(flat)] : [];
  }

  const out: LatLng[][] = [];
  let offset = 0;
  for (const count of counts) {
    out.push(decodePiece(flat.slice(offset, offset + count * 2)));
    offset += count * 2;
  }
  return out;
}

export function encodeStreet(street: Street): WireStreet {
  const { geometry, pieces } = encodePieces(street.geometry);

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

  return decodePieces({ geometry: geometry as number[], pieces: wire.pieces });
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

/**
 * One stretch the owner has struck off a street, kept separately from the
 * street's own geometry.
 *
 * This is the "exclude the missing part, not the whole street" decision: the
 * street stays exactly as OSM drew it, and this is laid over it as a mask at
 * read time. An id of its own because a street can end up with more than one
 * bad stretch found on different days, and each has to be undoable on its own.
 */
export type WireExcludedSegment = {
  id: string;
  streetId: string;
  createdAt: string;
  meters: number;
  geometry: number[];
  pieces: number[];
};

export type ExcludedSegment = {
  id: string;
  streetId: string;
  createdAt: string;
  meters: number;
  pieces: LatLng[][];
};

export function encodeExcludedSegment(segment: ExcludedSegment): WireExcludedSegment {
  const { geometry, pieces } = encodePieces(segment.pieces);
  return {
    id: segment.id,
    streetId: segment.streetId,
    createdAt: segment.createdAt,
    meters: Math.round(segment.meters * 10) / 10,
    geometry,
    pieces,
  };
}

export function decodeExcludedSegment(wire: WireExcludedSegment): ExcludedSegment {
  return {
    id: wire.id,
    streetId: wire.streetId,
    createdAt: wire.createdAt,
    meters: wire.meters ?? 0,
    pieces: decodePieces(wire).filter((piece) => piece.length >= 2),
  };
}

export function encodeExcludedSegments(segments: ExcludedSegment[]): WireExcludedSegment[] {
  return segments.map(encodeExcludedSegment);
}

export function decodeExcludedSegments(wire: WireExcludedSegment[] | undefined): ExcludedSegment[] {
  if (!Array.isArray(wire)) return [];
  return wire.map(decodeExcludedSegment).filter((segment) => segment.pieces.length > 0);
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
