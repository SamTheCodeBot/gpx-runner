import { intervalsIcuSource } from "./adapters/intervalsIcu";
import type { ActivitySource, ActivitySourceId } from "@/app/types";

/**
 * Adapter registry.
 *
 * The spine resolves providers through this map, so adding Garmin, Apple Health
 * or a plain file drop later means writing one `ActivitySource` and adding one
 * line here. Nothing else in the codebase needs to learn the provider's name.
 *
 * The existing Strava integration is intentionally absent: it stays as its own
 * personal-use routes under /api/strava, unchanged, because Strava's API terms
 * make it unusable as a foundation for club features.
 */
const SOURCES: Partial<Record<ActivitySourceId, ActivitySource>> = {
  intervals_icu: intervalsIcuSource,
};

export function getActivitySource(id: ActivitySourceId): ActivitySource {
  const source = SOURCES[id];
  if (!source) throw new Error(`No ingestion adapter registered for source: ${id}`);
  return source;
}

export function listActivitySources(): ActivitySource[] {
  return Object.values(SOURCES).filter((source): source is ActivitySource => Boolean(source));
}

export function isKnownSource(value: string): value is ActivitySourceId {
  return Object.prototype.hasOwnProperty.call(SOURCES, value);
}
