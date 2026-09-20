import { LatLng } from "../../types";
import { haversineMeters } from "../utils/geo";
import { RUNNABLE_HIGHWAY_VALUES, type OsmWay } from "./inventory";
import { scopeBounds, type StreetScope } from "./scope";

/**
 * Talking to Overpass: what to ask, and how to read the answer.
 *
 * The inventory has to come from OSM, because OSM is what the router runs on.
 * A street the router has never heard of could never be suggested and never be
 * completed, so any other source of "the streets of this town" would quietly
 * poison the project with chores that cannot be finished.
 *
 * Query building and parsing live here, away from the network, so both can be
 * tested without touching a free public service.
 */

export const OVERPASS_TIMEOUT_SECONDS = 120;

/**
 * Streets inside the scope polygon.
 *
 * Asked as a bounding box, answered as a polygon.
 *
 * A `poly:` filter with a hundred-point ring makes Overpass test every way it
 * selects against every edge, and around one Swedish town that reliably earns a
 * 504 from a service other people are also using. A bounding box is an index
 * lookup. The few extra ways in the corners cost nothing, because the ring is
 * applied in `buildStreetInventory` anyway — which is also what keeps a circle
 * and an administrative boundary the same single concept downstream.
 *
 * Access is filtered in `isRunnableStreetWay` rather than in the query, for the
 * same reason: a negated regex makes Overpass test every way it has already
 * selected, to remove five of them.
 */
export function buildStreetQuery(scope: StreetScope): string {
  const highways = RUNNABLE_HIGHWAY_VALUES.join("|");
  const bounds = scopeBounds(scope);
  const box = [bounds.minLat, bounds.minLng, bounds.maxLat, bounds.maxLng]
    .map((value) => value.toFixed(6))
    .join(",");

  return [
    `[out:json][timeout:${OVERPASS_TIMEOUT_SECONDS}];`,
    `way["highway"~"^(${highways})$"]["name"](${box});`,
    "out body geom;",
  ].join("");
}

/**
 * The named runnable ways at a point on the map.
 *
 * A tap, not an area. Asking "what is under my finger" is an index lookup on a
 * few metres of ground; asking "inventory everything within 2 km of my town"
 * is a quarter of a county, and that difference is the difference between an
 * answer in a second and a gateway timeout.
 *
 * The radius is a fingertip, widened by the caller for a coarse tap.
 */
export function buildStreetAtPointQuery(point: LatLng, radiusMeters: number): string {
  const highways = RUNNABLE_HIGHWAY_VALUES.join("|");
  return [
    "[out:json][timeout:30];",
    `way["highway"~"^(${highways})$"]["name"](around:${Math.round(radiusMeters)},${point.lat.toFixed(6)},${point.lng.toFixed(6)});`,
    "out body geom;",
  ].join("");
}

/**
 * Every way of one named street near a point.
 *
 * A tap lands on one OSM way, and an OSM way is a fragment: Storgatan is
 * chopped at every junction. Adding the fragment would put 80 m of a 900 m
 * street into the project and call it done the moment he crossed the road. So
 * the name is read off the tapped way and the rest of the street is collected
 * around it, then collapsed by the same inventory rules the project was built
 * with.
 */
export function buildNamedStreetQuery(point: LatLng, name: string, radiusMeters: number): string {
  const highways = RUNNABLE_HIGHWAY_VALUES.join("|");
  return [
    "[out:json][timeout:60];",
    `way["highway"~"^(${highways})$"]["name"="${escapeOverpassLiteral(name)}"](around:${Math.round(
      radiusMeters,
    )},${point.lat.toFixed(6)},${point.lng.toFixed(6)});`,
    "out body geom;",
  ].join("");
}

/**
 * A street name inside an Overpass string literal.
 *
 * Swedish street names carry no quotes, but a tag value is arbitrary text from
 * a public database and this is a query language. Escaped, not sanitised: the
 * name has to survive intact or it matches nothing.
 */
export function escapeOverpassLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Administrative areas containing a point, smallest first.
 *
 * Only tags: a boundary's geometry is hundreds of kilobytes and is worth
 * fetching once the owner has picked one, not for every candidate in a list.
 */
export function buildBoundaryCandidateQuery(point: LatLng): string {
  return [
    "[out:json][timeout:60];",
    `is_in(${point.lat.toFixed(6)},${point.lng.toFixed(6)})->.areas;`,
    'relation(pivot.areas)["boundary"="administrative"]["admin_level"];',
    "out tags;",
  ].join("");
}

export function buildBoundaryGeometryQuery(relationId: number): string {
  return `[out:json][timeout:90];relation(${relationId});out geom;`;
}

type OverpassElement = {
  type?: string;
  id?: number;
  tags?: Record<string, string>;
  nodes?: number[];
  geometry?: { lat: number; lon: number }[];
  members?: {
    type?: string;
    ref?: number;
    role?: string;
    geometry?: { lat: number; lon: number }[];
  }[];
};

type OverpassResponse = { elements?: OverpassElement[] };

export function parseOverpassWays(payload: unknown): OsmWay[] {
  const elements = (payload as OverpassResponse)?.elements;
  if (!Array.isArray(elements)) return [];

  const ways: OsmWay[] = [];

  for (const element of elements) {
    if (element.type !== "way" || typeof element.id !== "number") continue;
    const geometry = toLatLngs(element.geometry);
    if (geometry.length < 2) continue;

    ways.push({
      id: element.id,
      tags: element.tags ?? {},
      nodes: Array.isArray(element.nodes) ? element.nodes : undefined,
      geometry,
    });
  }

  return ways;
}

export type BoundaryCandidate = {
  osmId: number;
  name: string;
  adminLevel: number;
  /** `place` or `border_type` when OSM offers one — "town", "municipality". */
  kind?: string;
};

/**
 * Administrative candidates, smallest unit first.
 *
 * No attempt is made to understand what a Swedish admin level *means*. A
 * kommun and the town it is named after can share a name and differ by a factor
 * of thirty in area, and the rule that sorts them out is not semantics, it is
 * the street count shown next to each one before anything is created.
 */
export function parseBoundaryCandidates(payload: unknown): BoundaryCandidate[] {
  const elements = (payload as OverpassResponse)?.elements;
  if (!Array.isArray(elements)) return [];

  const candidates: BoundaryCandidate[] = [];

  for (const element of elements) {
    if (element.type !== "relation" || typeof element.id !== "number") continue;
    const tags = element.tags ?? {};
    const name = tags["name:sv"] || tags.name;
    const adminLevel = Number(tags.admin_level);
    if (!name || !Number.isFinite(adminLevel)) continue;

    candidates.push({
      osmId: element.id,
      name,
      adminLevel,
      kind: tags.place || tags.border_type || undefined,
    });
  }

  return candidates.sort((a, b) => b.adminLevel - a.adminLevel);
}

/**
 * The outer ring of a boundary relation.
 *
 * A relation is a bag of ways in no particular order and no particular
 * direction; a usable polygon is made by walking from one way's end to whatever
 * way starts there, flipping as needed. Holes and exclaves exist, so the
 * largest closed ring wins — for scoping a run project, the mainland shape of a
 * town is the shape that matters.
 */
export function assembleBoundaryRing(payload: unknown): LatLng[] {
  const elements = (payload as OverpassResponse)?.elements;
  if (!Array.isArray(elements)) return [];

  const relation = elements.find((element) => element.type === "relation");
  const members = relation?.members ?? [];

  const pieces = members
    .filter((member) => member.type === "way" && member.role !== "inner")
    .map((member) => toLatLngs(member.geometry))
    .filter((piece) => piece.length >= 2);

  const rings = stitchRings(pieces);
  if (rings.length === 0) return [];

  return rings.reduce((largest, ring) => (ringSpan(ring) > ringSpan(largest) ? ring : largest));
}

/** Ends within this distance are the same point; OSM shares nodes exactly. */
const STITCH_TOLERANCE_METERS = 5;

function stitchRings(pieces: LatLng[][]): LatLng[][] {
  const remaining = pieces.map((piece) => [...piece]);
  const rings: LatLng[][] = [];

  while (remaining.length > 0) {
    let ring = remaining.shift() as LatLng[];
    let extended = true;

    while (extended) {
      extended = false;
      const tail = ring[ring.length - 1];

      for (let i = 0; i < remaining.length; i += 1) {
        const piece = remaining[i];
        const head = piece[0];
        const end = piece[piece.length - 1];

        if (haversineMeters(tail, head) <= STITCH_TOLERANCE_METERS) {
          ring = ring.concat(piece.slice(1));
        } else if (haversineMeters(tail, end) <= STITCH_TOLERANCE_METERS) {
          ring = ring.concat([...piece].reverse().slice(1));
        } else {
          continue;
        }

        remaining.splice(i, 1);
        extended = true;
        break;
      }

      if (ring.length > 1 && haversineMeters(ring[0], ring[ring.length - 1]) <= STITCH_TOLERANCE_METERS) {
        break;
      }
    }

    if (ring.length >= 4) rings.push(closeRing(ring));
  }

  return rings;
}

function closeRing(ring: LatLng[]): LatLng[] {
  if (ring.length > 1 && haversineMeters(ring[0], ring[ring.length - 1]) <= STITCH_TOLERANCE_METERS) {
    return ring.slice(0, -1);
  }
  return ring;
}

function ringSpan(ring: LatLng[]): number {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;

  for (const point of ring) {
    if (point.lat < minLat) minLat = point.lat;
    if (point.lat > maxLat) maxLat = point.lat;
    if (point.lng < minLng) minLng = point.lng;
    if (point.lng > maxLng) maxLng = point.lng;
  }

  return (maxLat - minLat) * (maxLng - minLng);
}

function toLatLngs(geometry: { lat: number; lon: number }[] | undefined): LatLng[] {
  if (!Array.isArray(geometry)) return [];
  return geometry
    .filter((point) => point && Number.isFinite(point.lat) && Number.isFinite(point.lon))
    .map((point) => ({ lat: point.lat, lng: point.lon }));
}
