import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { OsmWay } from "../../src/engine/streets/inventory";

/**
 * The real street network of one Swedish town, as Overpass returned it.
 *
 * Recorded rather than invented, because the number this fixture exists to pin
 * down — 895 named ways collapsing to 614 streets — is a fact about how OSM
 * chops real roads up, and no hand-built grid would reproduce it. Trimmed to
 * the tags the inventory reads and rounded to five decimals (~1 m), which keeps
 * it small enough to live in the repo.
 *
 * Query: way[highway~"^(residential|living_street|unclassified|pedestrian)$"]
 *        [name](around:6000,56.9070,12.5072)
 * Data © OpenStreetMap contributors, ODbL.
 */

export const FALKENBERG_HOME = { lat: 56.907, lng: 12.5072 };
export const FIXTURE_RADIUS_METERS = 6000;

type FixtureWay = {
  id: number;
  tags: Record<string, string>;
  nodes: number[];
  geometry: [number, number][];
};

let cached: OsmWay[] | null = null;

export function falkenbergWays(): OsmWay[] {
  if (cached) return cached;

  const file = path.join(process.cwd(), "tests", "fixtures", "falkenberg-ways.json.gz");
  const payload = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as { ways: FixtureWay[] };

  cached = payload.ways.map((way) => ({
    id: way.id,
    tags: way.tags,
    nodes: way.nodes,
    geometry: way.geometry.map(([lat, lng]) => ({ lat, lng })),
  }));

  return cached;
}
