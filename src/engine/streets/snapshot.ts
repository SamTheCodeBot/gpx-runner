import { haversineMeters } from "../utils/geo";
import { centroid, normalizeStreetName, SPLIT_DISTANCE_METERS, type Street } from "./inventory";

/**
 * Why the denominator is frozen.
 *
 * OSM gains streets every week. If a project recomputed its street list live,
 * a new housing estate mapped on Tuesday would quietly enlarge the denominator,
 * and the owner would open the app after a good run to find his percentage had
 * gone *down*. He did nothing wrong; the goalposts moved. Do that twice and the
 * number stops meaning anything to him.
 *
 * So the street list is snapshotted when the project is created, and that
 * snapshot is what every percentage is computed against. New streets are found
 * only when asked for, shown by name, and added only when the owner says yes —
 * at which point the number moves *and he knows exactly why*.
 */

export type StreetSnapshot = {
  /** ISO timestamp of the Overpass read this list came from. */
  takenAt: string;
  streets: Street[];
  totalMeters: number;
};

export type InventoryDiff = {
  /** In OSM now, not in the snapshot. Offered, never applied on its own. */
  added: Street[];
  /** In the snapshot, no longer in OSM. Kept until the owner decides. */
  removed: Street[];
  /** Matched on both sides. */
  unchangedCount: number;
};

/** Same name, and no further apart than the rule that splits one name in two. */
const MATCH_DISTANCE_METERS = SPLIT_DISTANCE_METERS;

export function makeSnapshot(streets: Street[], takenAt = new Date().toISOString()): StreetSnapshot {
  return {
    takenAt,
    streets,
    totalMeters: streets.reduce((sum, street) => sum + street.lengthMeters, 0),
  };
}

/**
 * What changed in OSM since the snapshot.
 *
 * Streets are matched by name and place rather than by id, because an id
 * carries a centroid and a centroid moves when a mapper extends a cul-de-sac by
 * thirty metres. Matching on "same name, same part of town" survives that; it
 * would take a genuinely new street to look like an addition.
 */
export function diffInventories(snapshot: Street[], fresh: Street[]): InventoryDiff {
  const byName = new Map<string, Street[]>();
  for (const street of snapshot) {
    const key = normalizeStreetName(street.name);
    const bucket = byName.get(key);
    if (bucket) bucket.push(street);
    else byName.set(key, [street]);
  }

  const matched = new Set<Street>();
  const added: Street[] = [];

  for (const street of fresh) {
    const candidates = byName.get(normalizeStreetName(street.name)) ?? [];
    const here = centroid(street.geometry);

    let best: Street | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const candidate of candidates) {
      if (matched.has(candidate)) continue;
      const distance = haversineMeters(here, centroid(candidate.geometry));
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }

    if (best && bestDistance <= MATCH_DISTANCE_METERS) matched.add(best);
    else added.push(street);
  }

  return {
    added,
    removed: snapshot.filter((street) => !matched.has(street)),
    unchangedCount: matched.size,
  };
}

/**
 * Fold accepted additions into the snapshot.
 *
 * Only what the owner picked: an addition he ignored stays out of the
 * denominator, and the project keeps measuring the town he signed up for.
 */
export function adoptStreets(snapshot: StreetSnapshot, additions: Street[], at = new Date().toISOString()): StreetSnapshot {
  const known = new Set(snapshot.streets.map((street) => street.id));
  const merged = [...snapshot.streets];

  for (const street of additions) {
    if (known.has(street.id)) continue;
    known.add(street.id);
    merged.push(street);
  }

  merged.sort((a, b) => a.name.localeCompare(b.name, "sv-SE") || a.part - b.part);

  return {
    takenAt: at,
    streets: merged,
    totalMeters: merged.reduce((sum, street) => sum + street.lengthMeters, 0),
  };
}

/**
 * The sentence shown the moment the number is about to move.
 *
 * Never "your progress changed". Always what changed, how many, and which —
 * the list of names is the whole point, because it is the only thing that turns
 * a drop in a percentage from a betrayal into a fact about the world.
 */
export function describeInventoryDiff(diff: InventoryDiff): string {
  const parts: string[] = [];

  if (diff.added.length > 0) {
    const names = diff.added.slice(0, 6).map((street) => street.name);
    const rest = diff.added.length - names.length;
    const list = rest > 0 ? `${names.join(", ")} and ${rest} more` : names.join(", ");
    parts.push(
      `${diff.added.length} new street${diff.added.length === 1 ? "" : "s"} ${
        diff.added.length === 1 ? "has" : "have"
      } been mapped in OSM since this project started: ${list}.`,
    );
  }

  if (diff.removed.length > 0) {
    const names = diff.removed.slice(0, 6).map((street) => street.name);
    const rest = diff.removed.length - names.length;
    const list = rest > 0 ? `${names.join(", ")} and ${rest} more` : names.join(", ");
    parts.push(
      `${diff.removed.length} street${diff.removed.length === 1 ? "" : "s"} in this project ${
        diff.removed.length === 1 ? "is" : "are"
      } no longer in OSM: ${list}.`,
    );
  }

  if (parts.length === 0) return "OSM has not changed inside this project since the street list was taken.";
  return parts.join(" ");
}
