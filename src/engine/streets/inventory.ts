import { LatLng } from "../../types";
import { haversineMeters, polylineDistanceMeters, simplifyByDistance } from "../utils/geo";
import { clipToScope, isInsideScope, type StreetScope } from "./scope";

/**
 * Turning OSM ways into the list of streets a project is measured against.
 *
 * OSM does not hold streets. It holds ways: one street is chopped at every
 * junction, every surface change and every point two mappers stopped on
 * different days. Around one Swedish town, 895 named ways are 614 streets. The
 * unit a runner thinks in is the street — "I've done Storgatan" — so the whole
 * inventory hangs on collapsing that 895 back down to 614 without also welding
 * together two unrelated roads that happen to share a name.
 *
 * The unit is deliberately never the neighbourhood: OSM tags those as labelled
 * points, not polygons, so their extent cannot be derived at all.
 */

export type OsmWay = {
  id: number;
  /** Way centreline, in order. */
  geometry: LatLng[];
  tags: Record<string, string>;
  /** Node ids, when the query asked for them. Junctions are exact when present. */
  nodes?: number[];
};

export type Street = {
  /** Stable within a snapshot, and carried across refreshes by name + place. */
  id: string;
  name: string;
  /** 0 when the name is one continuous street; 1..n for disconnected stretches. */
  part: number;
  wayIds: number[];
  /** The in-scope centreline, split where the street leaves the project area. */
  geometry: LatLng[][];
  /** Length of the in-scope centreline only. */
  lengthMeters: number;
};

export type StreetInventory = {
  streets: Street[];
  totalMeters: number;
  /** Ways that survived filtering — the raw number behind the collapse ratio. */
  wayCount: number;
};

/**
 * Runnable, named public streets.
 *
 * Requiring a `name` tag does most of the filtering for free: farm tracks,
 * service alleys, driveways and the great majority of footpaths carry no name,
 * so they never enter the inventory and never become an uncompletable chore.
 * What is left is exclusions a runner would agree with — you do not run the E6.
 */
export const RUNNABLE_HIGHWAY_VALUES = [
  "residential",
  "living_street",
  "unclassified",
  "pedestrian",
  "tertiary",
  "secondary",
  "primary",
  "road",
] as const;

export const EXCLUDED_HIGHWAY_VALUES = [
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "track",
] as const;

const RUNNABLE = new Set<string>(RUNNABLE_HIGHWAY_VALUES);
const EXCLUDED = new Set<string>(EXCLUDED_HIGHWAY_VALUES);

export function isRunnableStreetWay(tags: Record<string, string> | undefined): boolean {
  if (!tags) return false;

  const name = tags.name?.trim();
  if (!name) return false;

  const highway = tags.highway;
  if (!highway || EXCLUDED.has(highway) || !RUNNABLE.has(highway)) return false;

  const access = tags.access;
  if (access === "private" || access === "no") return false;

  // A pedestrian *area* is a square, not a street: its way is a closed outline
  // whose length means nothing to a runner.
  if (tags.area === "yes") return false;

  return true;
}

/**
 * Two stretches of the same name this far apart with no junction between them
 * are two streets. Below it, one street that OSM simply broke in half.
 */
export const SPLIT_DISTANCE_METERS = 500;

/** Way ends this close are the same junction even when node ids are missing. */
const JUNCTION_TOLERANCE_METERS = 20;

/** How far apart two carriageways of one road may be and still be one street. */
const PARALLEL_CARRIAGEWAY_METERS = 30;

export function normalizeStreetName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase("sv-SE");
}

export function streetSlug(name: string): string {
  const slug = normalizeStreetName(name)
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "street";
}

export type InventoryOptions = {
  /** Overridable so a test can make the split rule bite at a readable scale. */
  splitDistanceMeters?: number;
};

/**
 * The streets of a scope, from the ways Overpass returned.
 *
 * Connectivity is judged on the *whole* way, not on the clipped one: a street
 * that leaves the project area and comes back is still one street, and it would
 * be absurd for the edge of a circle drawn on a map to split a road in two.
 * Only the length is clipped.
 */
export function buildStreetInventory(
  ways: OsmWay[],
  scope: StreetScope,
  options: InventoryOptions = {},
): StreetInventory {
  const splitDistance = options.splitDistanceMeters ?? SPLIT_DISTANCE_METERS;

  const usable = ways.filter(
    (way) => isRunnableStreetWay(way.tags) && Array.isArray(way.geometry) && way.geometry.length >= 2,
  );

  const groups = new Map<string, OsmWay[]>();
  for (const way of usable) {
    const key = normalizeStreetName(way.tags.name);
    const bucket = groups.get(key);
    if (bucket) bucket.push(way);
    else groups.set(key, [way]);
  }

  const streets: Street[] = [];

  for (const group of Array.from(groups.values())) {
    const components = splitIntoStreets(group, splitDistance);
    const displayName = mostCommonName(group);

    const built = components
      .map((component) => buildStreet(displayName, component, scope))
      .filter((street): street is Street => street !== null);

    if (built.length === 1) {
      streets.push({ ...built[0], part: 0, id: streetSlug(displayName) });
      continue;
    }

    // Ordered south-west first so the numbering a person sees does not shuffle
    // between two snapshots of the same unchanged town.
    built.sort((a, b) => {
      const ca = centroid(a.geometry);
      const cb = centroid(b.geometry);
      return ca.lat - cb.lat || ca.lng - cb.lng;
    });

    built.forEach((street, index) => {
      const anchor = centroid(street.geometry);
      streets.push({
        ...street,
        part: index + 1,
        id: `${streetSlug(displayName)}@${anchor.lat.toFixed(3)},${anchor.lng.toFixed(3)}`,
      });
    });
  }

  streets.sort((a, b) => a.name.localeCompare(b.name, "sv-SE") || a.part - b.part);

  return {
    streets,
    totalMeters: streets.reduce((sum, street) => sum + street.lengthMeters, 0),
    wayCount: usable.length,
  };
}

/**
 * One name, split into the streets it really is.
 *
 * Ways join when they share a junction — an OSM node id, or, when the query did
 * not ask for node ids, ends that touch on the ground. They also join when they
 * run close to each other, because a mapper breaking a street at a roundabout
 * leaves a gap of metres, not of hundreds. What stays apart is the case the
 * owner will meet the first time he adds a second town: "Storgatan" is the main
 * street of nearly every place in Sweden.
 */
function splitIntoStreets(ways: OsmWay[], splitDistanceMeters: number): OsmWay[][] {
  const parent = ways.map((_, index) => index);

  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    let cursor = index;
    while (parent[cursor] !== cursor) {
      const next = parent[cursor];
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };

  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  const nodeOwners = new Map<number, number>();
  ways.forEach((way, index) => {
    for (const node of way.nodes ?? []) {
      const owner = nodeOwners.get(node);
      if (owner === undefined) nodeOwners.set(node, index);
      else union(owner, index);
    }
  });

  const samples = ways.map((way) => simplifyByDistance(way.geometry, 40));

  for (let i = 0; i < ways.length; i += 1) {
    for (let j = i + 1; j < ways.length; j += 1) {
      if (find(i) === find(j)) continue;
      if (
        endsTouch(ways[i].geometry, ways[j].geometry) ||
        minDistanceMeters(samples[i], samples[j]) <= splitDistanceMeters
      ) {
        union(i, j);
      }
    }
  }

  const components = new Map<number, OsmWay[]>();
  ways.forEach((way, index) => {
    const root = find(index);
    const bucket = components.get(root);
    if (bucket) bucket.push(way);
    else components.set(root, [way]);
  });

  return Array.from(components.values());
}

function endsTouch(a: LatLng[], b: LatLng[]): boolean {
  const endsA = [a[0], a[a.length - 1]];
  const endsB = [b[0], b[b.length - 1]];
  for (const pointA of endsA) {
    for (const pointB of endsB) {
      if (haversineMeters(pointA, pointB) <= JUNCTION_TOLERANCE_METERS) return true;
    }
  }
  return false;
}

function minDistanceMeters(a: LatLng[], b: LatLng[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const pointA of a) {
    for (const pointB of b) {
      const distance = haversineMeters(pointA, pointB);
      if (distance < best) best = distance;
      if (best <= 1) return best;
    }
  }
  return best;
}

/**
 * One component, clipped to the scope and stripped of its second carriageway.
 *
 * The owner's rule is that one side or one direction of a road counts: he is
 * running streets, not sweeping tarmac. A dual carriageway or a one-way pair is
 * two ways of the same name lying a few metres apart, and counting both would
 * cap a perfectly run street at half. So a way that merely repeats ground the
 * street already has is dropped from the denominator.
 */
function buildStreet(name: string, ways: OsmWay[], scope: StreetScope): Street | null {
  const ordered = [...ways].sort(
    (a, b) => polylineDistanceMeters(b.geometry) - polylineDistanceMeters(a.geometry),
  );

  const geometry: LatLng[][] = [];
  const wayIds: number[] = [];
  const kept: LatLng[][] = [];

  for (const way of ordered) {
    if (repeatsExistingGround(way.geometry, kept)) continue;

    const pieces = clipToScope(way.geometry, scope).filter((piece) => piece.length >= 2);
    kept.push(way.geometry);
    if (pieces.length === 0) continue;

    wayIds.push(way.id);
    for (const piece of pieces) geometry.push(piece);
  }

  if (geometry.length === 0) return null;

  const lengthMeters = geometry.reduce((sum, piece) => sum + polylineDistanceMeters(piece), 0);
  if (lengthMeters < 1) return null;

  return {
    id: streetSlug(name),
    name,
    part: 0,
    wayIds: wayIds.sort((a, b) => a - b),
    geometry,
    lengthMeters,
  };
}

function repeatsExistingGround(candidate: LatLng[], kept: LatLng[][]): boolean {
  if (kept.length === 0) return false;

  const samples = simplifyByDistance(candidate, 25);
  if (samples.length === 0) return false;

  let covered = 0;
  for (const sample of samples) {
    const near = kept.some((existing) => nearestPointDistance(sample, existing) <= PARALLEL_CARRIAGEWAY_METERS);
    if (near) covered += 1;
  }

  return covered / samples.length >= 0.9;
}

function nearestPointDistance(point: LatLng, polyline: LatLng[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < polyline.length; i += 1) {
    const distance = pointToSegment(point, polyline[i - 1], polyline[i]);
    if (distance < best) best = distance;
    if (best <= 1) return best;
  }
  if (polyline.length === 1) return haversineMeters(point, polyline[0]);
  return best;
}

function pointToSegment(point: LatLng, a: LatLng, b: LatLng): number {
  const latScale = 111_320;
  const lngScale = 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);

  const px = (point.lng - a.lng) * lngScale;
  const py = (point.lat - a.lat) * latScale;
  const bx = (b.lng - a.lng) * lngScale;
  const by = (b.lat - a.lat) * latScale;

  const denominator = bx * bx + by * by;
  if (denominator === 0) return Math.sqrt(px * px + py * py);

  const t = Math.max(0, Math.min(1, (px * bx + py * by) / denominator));
  const dx = px - bx * t;
  const dy = py - by * t;
  return Math.sqrt(dx * dx + dy * dy);
}

function mostCommonName(ways: OsmWay[]): string {
  const counts = new Map<string, number>();
  for (const way of ways) {
    const name = way.tags.name.trim().replace(/\s+/g, " ");
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let best = ways[0].tags.name.trim();
  let bestCount = -1;
  for (const [name, count] of Array.from(counts.entries())) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

export function centroid(geometry: LatLng[][]): LatLng {
  let lat = 0;
  let lng = 0;
  let count = 0;
  for (const piece of geometry) {
    for (const point of piece) {
      lat += point.lat;
      lng += point.lng;
      count += 1;
    }
  }
  return count === 0 ? { lat: 0, lng: 0 } : { lat: lat / count, lng: lng / count };
}

/** Does any of this street lie inside the scope? Used for cheap previews. */
export function touchesScope(way: OsmWay, scope: StreetScope): boolean {
  return way.geometry.some((point) => isInsideScope(point, scope));
}
