import { haversineMeters } from "../utils/geo";
import { centroid, normalizeStreetName, SPLIT_DISTANCE_METERS, type Street } from "./inventory";

/**
 * Streets just outside the project, offered to be let in.
 *
 * A pin and a radius are a guess. The estate over the roundabout falls 200 m
 * outside the circle, the road he runs out and back along leaves it halfway,
 * and an administrative boundary cuts the street his own house is on. Without
 * a way to add those, the only fix is to delete the project and draw a bigger
 * circle — throwing away the months of progress that made it worth having.
 *
 * So addition is the mirror of exclusion, and obeys the same rule: never
 * automatic, always the owner's, one street at a time. Widening the *look* is
 * free; widening the *project* is a decision, and it is his.
 *
 * Two different things come back, because the circle can be wrong in two ways.
 * A street can be wholly outside it — that is an addition. Or a street can be
 * cut in half by it, already in the project as a stub, with the rest of itself
 * sitting just over the line — that is an extension, and it is the case the
 * frozen snapshot cannot express on its own.
 */

/** Same rule the snapshot diff uses: same name, same part of town. */
const MATCH_DISTANCE_METERS = SPLIT_DISTANCE_METERS;

/**
 * How much longer the wider look must find before it is worth mentioning.
 *
 * Both a ratio and a floor. OSM geometry jitters by a few metres between reads
 * and a clip boundary lands where it lands; without a floor every street that
 * touches the edge would be offered as an extension for ever.
 */
const EXTENSION_RATIO = 1.15;
const EXTENSION_FLOOR_METERS = 80;

export type StreetExtension = {
  /** The street as the wider look sees it: the one that would be stored. */
  street: Street;
  /** The id it replaces in the snapshot. */
  replacesId: string;
  wasMeters: number;
  nowMeters: number;
};

export type NearbyStreets = {
  /** Wholly outside the project area, not in the snapshot at all. */
  additions: Street[];
  /** Already in the project, but the area cut them short. */
  extensions: StreetExtension[];
};

/**
 * Compare the project's frozen list against a wider read of the same map.
 *
 * `snapshot` is what the project is measured against; `wider` is an inventory
 * taken over the grown area. Matching is by name and place rather than by id,
 * for the same reason the refresh diff does it: an id carries a centroid, and a
 * centroid moves the moment a mapper extends a cul-de-sac.
 */
export function findNearbyStreets(snapshot: Street[], wider: Street[]): NearbyStreets {
  const byName = new Map<string, Street[]>();
  for (const street of snapshot) {
    const key = normalizeStreetName(street.name);
    const bucket = byName.get(key);
    if (bucket) bucket.push(street);
    else byName.set(key, [street]);
  }

  const claimed = new Set<Street>();
  const additions: Street[] = [];
  const extensions: StreetExtension[] = [];

  for (const street of wider) {
    const candidates = byName.get(normalizeStreetName(street.name)) ?? [];
    const here = centroid(street.geometry);

    let best: Street | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const candidate of candidates) {
      if (claimed.has(candidate)) continue;
      const distance = haversineMeters(here, centroid(candidate.geometry));
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }

    if (!best || bestDistance > MATCH_DISTANCE_METERS) {
      additions.push(street);
      continue;
    }

    claimed.add(best);

    // Held already — but is the project holding all of it?
    const gained = street.lengthMeters - best.lengthMeters;
    if (gained >= EXTENSION_FLOOR_METERS && street.lengthMeters >= best.lengthMeters * EXTENSION_RATIO) {
      extensions.push({
        street,
        replacesId: best.id,
        wasMeters: Math.round(best.lengthMeters),
        nowMeters: Math.round(street.lengthMeters),
      });
    }
  }

  return { additions, extensions };
}

/**
 * Fold in the streets the owner picked.
 *
 * An extension replaces the stub it extends, keeping the snapshot's id so
 * anything already pointing at that street — an exclusion, a ticked route —
 * keeps pointing at it. A street that changed shape is the same street; a
 * street that changed id would silently lose the owner's decisions about it.
 */
export function mergeNearbyStreets(
  snapshot: Street[],
  chosen: { additions: Street[]; extensions: StreetExtension[] },
): Street[] {
  const replaced = new Map(chosen.extensions.map((extension) => [extension.replacesId, extension.street]));
  const held = new Set(snapshot.map((street) => street.id));

  const merged = snapshot.map((street) => {
    const extension = replaced.get(street.id);
    // The fuller geometry, under the id the project already knows it by.
    return extension ? { ...extension, id: street.id, part: street.part } : street;
  });

  for (const street of chosen.additions) {
    if (held.has(street.id)) continue;
    held.add(street.id);
    merged.push(street);
  }

  return merged.sort((a, b) => a.name.localeCompare(b.name, "sv-SE") || a.part - b.part);
}

/** "3 streets · 1.2 km to add" — the size of the decision, before he makes it. */
export function describeNearby(nearby: NearbyStreets): string {
  const parts: string[] = [];

  if (nearby.additions.length > 0) {
    const meters = nearby.additions.reduce((sum, street) => sum + street.lengthMeters, 0);
    parts.push(
      `${nearby.additions.length} street${nearby.additions.length === 1 ? "" : "s"} just outside your area · ${
        Math.round(meters / 100) / 10
      } km`,
    );
  }

  if (nearby.extensions.length > 0) {
    parts.push(
      `${nearby.extensions.length} street${nearby.extensions.length === 1 ? "" : "s"} the area cut short`,
    );
  }

  if (parts.length === 0) return "Nothing runnable found outside your area.";
  return parts.join(", ");
}
