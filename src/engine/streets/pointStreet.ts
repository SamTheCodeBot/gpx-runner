import { LatLng } from "../../types";
import { circleScope } from "./scope";
import { buildStreetInventory, type OsmWay, type Street } from "./inventory";
import { buildStreetPickIndex, pickStreetAt } from "./pick";

/**
 * The street under a tap on the map.
 *
 * Pointing at a road is the honest version of "my circle was not perfect". The
 * alternative — widening the project area and inventorying the band around it —
 * asks a global question to solve a local problem: he wants *that road there*,
 * and instead gets four hundred streets from the next town to sift through, at
 * the cost of a query big enough to time out.
 *
 * Two things have to happen between a finger and a street. A tap lands on one
 * OSM way, and an OSM way is a fragment: Storgatan is chopped at every
 * junction, so the way under his finger might be 80 m of a 900 m street.
 * Adding the fragment would put a stub in the project that completes the
 * moment he crosses the road. So the name is read off the tapped way, every
 * way of that name nearby is collected, and the lot is collapsed by the same
 * inventory rules the project itself was built with — which is what makes an
 * added street identical in kind to one that was there from the start.
 */

/** A tap is aimed with a fingertip; the caller widens this for a coarse zoom. */
export const POINT_MATCH_METERS = 30;

/**
 * How far around the tap to look for the rest of the street.
 *
 * Generous enough for a long town road, bounded so a tap never becomes a
 * regional query. A street longer than this is clipped, which is honest: it is
 * the same thing the project scope does to a street that leaves the area.
 */
export const NAMED_STREET_RADIUS_METERS = 2500;

export type TappedWay = {
  name: string;
  wayId: number;
};

/**
 * Which named way did he touch?
 *
 * Nearest wins, measured against the way's own geometry rather than its
 * centroid: two parallel roads thirty metres apart have centroids that say
 * nothing about which one is under the finger.
 */
export function wayAtPoint(ways: OsmWay[], point: LatLng, toleranceMeters = POINT_MATCH_METERS): TappedWay | null {
  // The pick index works in streets, so each way is offered as a street of one
  // way. No collapsing here: this stage only has to produce a name.
  const asStreets: Street[] = ways
    .filter((way) => way.tags?.name && Array.isArray(way.geometry) && way.geometry.length >= 2)
    .map((way, index) => ({
      id: String(way.id ?? index),
      name: way.tags.name,
      part: 0,
      wayIds: [way.id],
      geometry: [way.geometry],
      lengthMeters: 0,
    }));

  if (asStreets.length === 0) return null;

  const picked = pickStreetAt(point, buildStreetPickIndex(asStreets), toleranceMeters);
  if (!picked) return null;

  const hit = asStreets.find((street) => street.id === picked.streetId);
  if (!hit) return null;

  return { name: hit.name, wayId: hit.wayIds[0] };
}

/**
 * The whole street a tap belongs to, built from every way of that name nearby.
 *
 * `ways` is the answer to the name query. The result is collapsed exactly as
 * `buildStreetInventory` collapses a town, so a street added this way is
 * indistinguishable from one the project started with — same splitting rule,
 * same naming, same geometry handling.
 *
 * The clip circle is centred on the tap rather than on the project, because
 * the entire point is that this street may be nowhere near the project's area.
 */
export function streetAtPoint(
  ways: OsmWay[],
  point: LatLng,
  options: { radiusMeters?: number; toleranceMeters?: number } = {},
): Street | null {
  const radius = options.radiusMeters ?? NAMED_STREET_RADIUS_METERS;
  const inventory = buildStreetInventory(ways, circleScope(point, radius));
  if (inventory.streets.length === 0) return null;

  // One name can still be several streets — two Kyrkogatans either side of
  // town, or one name split at a 500 m gap. Take the one he pointed at.
  const picked = pickStreetAt(
    point,
    buildStreetPickIndex(inventory.streets),
    options.toleranceMeters ?? POINT_MATCH_METERS,
  );
  if (picked) return inventory.streets.find((street) => street.id === picked.streetId) ?? null;

  // The tap was inside the fragment but the collapsed street drifted past the
  // tolerance — fall back to the nearest street of that name rather than
  // telling him there is no road where he can plainly see one.
  return inventory.streets[0] ?? null;
}
