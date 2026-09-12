import { LatLng } from "../../types";
import { buildFamiliarityIndex } from "../familiarity";
import { computeProjectCoverage, type ProjectCoverage } from "./coverage";
import type { Street } from "./inventory";
import type { StreetScope } from "./scope";

/**
 * A street completion project: an area, a frozen list of its streets, and the
 * runner's whole history measured against it.
 *
 * Projects are plural on purpose. He lives in one town, works in another and
 * runs there at lunch, and turns up in Frankfurt for a week twice a year. The
 * history is one history — every run he has ever logged — and it is the *scope*
 * that differs, so a Varberg run lands in the Varberg project and nowhere else,
 * while two projects that overlap both count the same run without either being
 * told about the other. Creation therefore has to be cheap enough to be worth
 * doing on a hunch: a pin, a radius, a name.
 */

export type StreetProjectSummary = {
  id: string;
  name: string;
  createdAt: string;
  archivedAt: string | null;
  scope: StreetScope;
  /** The frozen denominator. Never recomputed behind the owner's back. */
  streetCount: number;
  totalMeters: number;
  snapshotTakenAt: string;
  /** Named ways behind the street count, kept as evidence of the collapse. */
  wayCount: number;
  /** Set by a refresh: streets OSM has gained, waiting for a yes or a no. */
  pendingAdditionCount?: number;
  lastRefreshedAt?: string | null;
};

export type StreetProjectProgress = ProjectCoverage & {
  projectId: string;
  computedAt: string;
};

/**
 * Progress for one project, from the owner's tracks.
 *
 * The index is built from every track handed in, not from the ones near the
 * scope, because the caller already holds the history and trimming it here
 * would only hide runs that clip the edge of the area.
 *
 * A brand new project runs through exactly this path with the full history, so
 * a Falkenberg project opens on what his 1,458 km already cover rather than on
 * a zero he has to earn back. That first number is the feature.
 */
export function computeProjectProgress(
  projectId: string,
  streets: Street[],
  tracks: LatLng[][],
  computedAt = new Date().toISOString(),
): StreetProjectProgress {
  const index = buildFamiliarityIndex(tracks);
  return { projectId, computedAt, ...computeProjectCoverage(streets, index) };
}

/** "614 streets · 187 km" — the safety check before a project is created. */
export function describeScopeSize(streetCount: number, totalMeters: number): string {
  const km = Math.round(totalMeters / 100) / 10;
  return `${streetCount} street${streetCount === 1 ? "" : "s"} · ${km} km`;
}

export function progressHeadline(progress: ProjectCoverage): string {
  const percent = Math.round(progress.ratio * 1000) / 10;
  return `${progress.streetsComplete} of ${progress.streetsTotal} streets · ${percent}%`;
}
