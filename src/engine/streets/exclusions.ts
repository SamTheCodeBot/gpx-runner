import type { Street } from "./inventory";

/**
 * Streets the owner has struck off his own project.
 *
 * The tag rules in `inventory.ts` know that nobody runs the E6. What they
 * cannot know is that one particular `primary` through town has no pavement, a
 * 80 km/h limit and lorries on it — that is local knowledge, and it lives in
 * the runner's head. Without a way to say so, a project keeps a handful of
 * streets that will never be ticked, the percentage can never reach 100, and
 * the whole thing stops being a goal and becomes a reproach.
 *
 * So exclusion is a first-class, per-project decision, and it works the same
 * way adoption does: never automatic, always the owner's, always reversible.
 *
 * It shrinks the denominator. That was his call and it is the honest one — he
 * is the one keeping track of the numbers and the one deciding what comes out,
 * so a street he has ruled out should stop being counted as something he owes.
 * The alternative, holding the denominator fixed, would leave a project that
 * reads 98% forever with two roads in it he has explicitly said he will never
 * run.
 *
 * Exclusions are stored as street ids against the project rather than as a
 * rule about road types, deliberately. A rule ("drop every primary") would be
 * wrong in both directions at once: the high street is a `primary` he runs
 * every week, and the dangerous stretch two towns over is tagged `secondary`.
 * The unit of the decision is the street he pointed at.
 */

export type StreetPartition = {
  /** Counted in the project: the denominator every percentage is over. */
  active: Street[];
  /** Struck off. Kept whole, so putting one back is one tap and no refetch. */
  excluded: Street[];
};

export function partitionStreets(streets: Street[], excludedIds: Iterable<string>): StreetPartition {
  const excludedSet = excludedIds instanceof Set ? excludedIds : new Set(excludedIds);
  if (excludedSet.size === 0) return { active: streets, excluded: [] };

  const active: Street[] = [];
  const excluded: Street[] = [];
  for (const street of streets) {
    if (excludedSet.has(street.id)) excluded.push(street);
    else active.push(street);
  }
  return { active, excluded };
}

/**
 * Apply a change to the excluded set.
 *
 * Returned sorted and deduplicated so the stored array is stable: two clients
 * excluding the same street in a different order must not produce two
 * different documents, or every read looks like a write.
 */
export function applyExclusionChange(
  current: Iterable<string>,
  change: { streetIds: string[]; excluded: boolean },
): string[] {
  const next = new Set(current);
  for (const id of change.streetIds) {
    if (change.excluded) next.add(id);
    else next.delete(id);
  }
  return [...next].sort();
}

/**
 * Drop exclusions for streets the project no longer holds.
 *
 * A snapshot can be rewritten — adopting new streets rewrites the whole list —
 * and an id left pointing at nothing would sit in the document forever, quietly
 * inflating a count the owner can no longer see or undo.
 */
export function pruneExclusions(excludedIds: Iterable<string>, streets: Street[]): string[] {
  const live = new Set(streets.map((street) => street.id));
  return [...new Set(excludedIds)].filter((id) => live.has(id)).sort();
}

/** "2 streets · 1.4 km excluded" — what the owner took out, said back to him. */
export function describeExclusions(excluded: Street[]): string {
  const meters = excluded.reduce((sum, street) => sum + street.lengthMeters, 0);
  const km = Math.round(meters / 100) / 10;
  return `${excluded.length} street${excluded.length === 1 ? "" : "s"} · ${km} km`;
}
