"use client";

import type { User } from "firebase/auth";

import type { Street } from "@/engine/streets/inventory";
import type { BoundaryCandidate } from "@/engine/streets/overpass";
import type { StreetScope } from "@/engine/streets/scope";
import { decodeScope, decodeStreets, encodeScope, type WireScope, type WireStreet } from "@/engine/streets/serialize";

/**
 * The browser's side of street completion projects.
 *
 * Street lists come down once and are cached: a town is a few hundred
 * kilobytes of geometry, and the whole point of a snapshot is that it does not
 * change between visits. Coverage itself is computed in the browser against the
 * runner's own tracks — the same place the familiarity engine already runs, and
 * the only place his entire history is already sitting in memory.
 */

export type ProjectSummary = {
  id: string;
  name: string;
  createdAt: string;
  archivedAt: string | null;
  scope: StreetScope;
  streetCount: number;
  totalMeters: number;
  wayCount: number;
  snapshotTakenAt: string;
  lastRefreshedAt: string | null;
  pendingAdditionCount: number;
  /** Streets struck off by the owner. Out of every percentage, still in the map. */
  excludedStreetIds: string[];
  /** Streets let in from outside the project area. */
  addedStreetIds: string[];
};

export type ScopeRequest =
  | { kind: "circle"; lat: number; lng: number; radiusMeters: number }
  | { kind: "boundary"; osmId: number; name: string; adminLevel: number }
  | { kind: "stored"; scope: WireScope };

export type ScopePreview = {
  streetCount: number;
  wayCount: number;
  totalMeters: number;
  areaKm2: number;
  longestStreets: string[];
  scope: StreetScope;
};

export type ProjectDetail = {
  project: ProjectSummary;
  streets: Street[];
  pending: { foundAt: string | null; streets: Street[]; removedNames: string[] };
};

export class ApiError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "ApiError";
  }
}

async function authed(user: User, path: string, init: RequestInit = {}): Promise<any> {
  const idToken = await user.getIdToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${idToken}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(payload?.error ?? `Request failed (${response.status})`, Boolean(payload?.retryable));
  }
  return payload;
}

function toSummary(raw: any): ProjectSummary {
  return {
    id: raw.id,
    name: raw.name,
    createdAt: raw.createdAt,
    archivedAt: raw.archivedAt ?? null,
    scope: decodeScope(raw.scope as WireScope),
    streetCount: raw.streetCount ?? 0,
    totalMeters: raw.totalMeters ?? 0,
    wayCount: raw.wayCount ?? 0,
    snapshotTakenAt: raw.snapshotTakenAt ?? raw.createdAt,
    lastRefreshedAt: raw.lastRefreshedAt ?? null,
    pendingAdditionCount: raw.pendingAdditionCount ?? 0,
    excludedStreetIds: raw.excludedStreetIds ?? [],
    addedStreetIds: raw.addedStreetIds ?? [],
  };
}

export async function listProjects(user: User): Promise<ProjectSummary[]> {
  const payload = await authed(user, "/api/street-projects");
  return (payload.projects ?? []).map(toSummary);
}

export async function previewScope(user: User, scope: ScopeRequest): Promise<ScopePreview> {
  const payload = await authed(user, "/api/street-projects/preview", {
    method: "POST",
    body: JSON.stringify({ scope }),
  });

  return {
    streetCount: payload.streetCount,
    wayCount: payload.wayCount,
    totalMeters: payload.totalMeters,
    areaKm2: payload.areaKm2,
    longestStreets: payload.longestStreets ?? [],
    scope: decodeScope(payload.scope as WireScope),
  };
}

export async function createProject(
  user: User,
  name: string,
  scope: ScopeRequest,
): Promise<{ project: ProjectSummary; streets: Street[] }> {
  const payload = await authed(user, "/api/street-projects", {
    method: "POST",
    body: JSON.stringify({ name, scope }),
  });

  return { project: toSummary(payload.project), streets: decodeStreets(payload.streets as WireStreet[]) };
}

export async function loadProject(user: User, projectId: string): Promise<ProjectDetail> {
  const payload = await authed(user, `/api/street-projects/${projectId}`);
  return {
    project: toSummary(payload.project),
    streets: decodeStreets(payload.streets as WireStreet[]),
    pending: {
      foundAt: payload.pending?.foundAt ?? null,
      streets: decodeStreets(payload.pending?.streets as WireStreet[]),
      removedNames: payload.pending?.removedNames ?? [],
    },
  };
}

export async function patchProject(
  user: User,
  projectId: string,
  patch: { name?: string; archived?: boolean },
): Promise<ProjectSummary> {
  const payload = await authed(user, `/api/street-projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return toSummary(payload.project);
}

/**
 * Strike streets off the project, or put them back.
 *
 * Takes an array because undoing a batch, or ruling out the four ways that
 * make up one dual carriageway, should cost one request and one undo.
 */
export async function setStreetExclusions(
  user: User,
  projectId: string,
  streetIds: string[],
  excluded: boolean,
): Promise<ProjectSummary> {
  const payload = await authed(user, `/api/street-projects/${projectId}/exclude`, {
    method: "POST",
    body: JSON.stringify({ streetIds, excluded }),
  });
  return toSummary(payload.project);
}

/**
 * What is just outside the project area.
 *
 * The circle was a guess. This is the correction: streets wholly outside it,
 * and streets it cut in half that carry on over the line. Nothing is changed
 * until `addNearbyStreets` is called with the ones he picked.
 */
export type StreetExtensionView = {
  street: Street;
  replacesId: string;
  wasMeters: number;
  nowMeters: number;
};

export type NearbyResult = {
  marginMeters: number;
  message: string;
  additions: Street[];
  extensions: StreetExtensionView[];
  truncated: boolean;
};

export async function findNearbyStreets(
  user: User,
  projectId: string,
  marginMeters: number,
): Promise<NearbyResult> {
  const payload = await authed(user, `/api/street-projects/${projectId}/nearby`, {
    method: "POST",
    body: JSON.stringify({ marginMeters }),
  });

  return {
    marginMeters: payload.marginMeters ?? marginMeters,
    message: payload.message ?? "",
    additions: decodeStreets(payload.additions as WireStreet[]),
    extensions: (payload.extensions ?? []).map((raw: any) => ({
      street: decodeStreets([raw.street as WireStreet])[0],
      replacesId: raw.replacesId,
      wasMeters: raw.wasMeters ?? 0,
      nowMeters: raw.nowMeters ?? 0,
    })),
    truncated: Boolean(payload.truncated),
  };
}

export async function addNearbyStreets(
  user: User,
  projectId: string,
  streetIds: string[],
  marginMeters: number,
): Promise<{ project: Omit<ProjectSummary, "scope">; streets: Street[]; addedCount: number }> {
  const payload = await authed(user, `/api/street-projects/${projectId}/nearby`, {
    method: "PUT",
    body: JSON.stringify({ streetIds, marginMeters }),
  });

  const raw = payload.project ?? {};
  return {
    // The scope is unchanged by design, so the server does not send it back.
    project: {
      id: raw.id,
      name: raw.name,
      createdAt: raw.createdAt,
      archivedAt: raw.archivedAt ?? null,
      streetCount: raw.streetCount ?? 0,
      totalMeters: raw.totalMeters ?? 0,
      wayCount: raw.wayCount ?? 0,
      snapshotTakenAt: raw.snapshotTakenAt ?? raw.createdAt,
      lastRefreshedAt: raw.lastRefreshedAt ?? null,
      pendingAdditionCount: raw.pendingAdditionCount ?? 0,
      excludedStreetIds: raw.excludedStreetIds ?? [],
      addedStreetIds: raw.addedStreetIds ?? [],
    },
    streets: decodeStreets(payload.streets as WireStreet[]),
    addedCount: payload.addedCount ?? 0,
  };
}

/**
 * Point at a road on the map and put it in the project.
 *
 * Two small queries instead of an inventory of the whole band around the town:
 * what is under the finger, and the rest of the street it belongs to. That is
 * why this answers where a wide margin scan times out.
 */
export type StreetAtPoint = {
  kind: "addition" | "extension" | "already_in_project";
  street: Street;
  name: string;
  lengthMeters: number;
  replacesId?: string;
  wasMeters?: number;
  nowMeters?: number;
};

export async function identifyStreetAt(
  user: User,
  projectId: string,
  point: { lat: number; lng: number },
  toleranceMeters: number,
): Promise<StreetAtPoint> {
  const payload = await authed(user, `/api/street-projects/${projectId}/street-at`, {
    method: "POST",
    body: JSON.stringify({ ...point, toleranceMeters }),
  });

  return {
    kind: payload.kind,
    street: decodeStreets([payload.street as WireStreet])[0],
    name: payload.name,
    lengthMeters: payload.lengthMeters ?? 0,
    replacesId: payload.replacesId,
    wasMeters: payload.wasMeters,
    nowMeters: payload.nowMeters,
  };
}

export async function addStreetAt(
  user: User,
  projectId: string,
  point: { lat: number; lng: number },
  toleranceMeters: number,
): Promise<{ project: Omit<ProjectSummary, "scope">; streets: Street[]; name: string; kind: string }> {
  const payload = await authed(user, `/api/street-projects/${projectId}/street-at`, {
    method: "PUT",
    body: JSON.stringify({ ...point, toleranceMeters }),
  });

  const raw = payload.project ?? {};
  return {
    project: {
      id: raw.id,
      name: raw.name,
      createdAt: raw.createdAt,
      archivedAt: raw.archivedAt ?? null,
      streetCount: raw.streetCount ?? 0,
      totalMeters: raw.totalMeters ?? 0,
      wayCount: raw.wayCount ?? 0,
      snapshotTakenAt: raw.snapshotTakenAt ?? raw.createdAt,
      lastRefreshedAt: raw.lastRefreshedAt ?? null,
      pendingAdditionCount: raw.pendingAdditionCount ?? 0,
      excludedStreetIds: raw.excludedStreetIds ?? [],
      addedStreetIds: raw.addedStreetIds ?? [],
    },
    streets: decodeStreets(payload.streets as WireStreet[]),
    name: payload.name ?? "That street",
    kind: payload.kind ?? "addition",
  };
}

export type RefreshResult = {
  message: string;
  added: Street[];
  removedNames: string[];
};

export async function refreshProject(user: User, projectId: string): Promise<RefreshResult> {
  const payload = await authed(user, `/api/street-projects/${projectId}/refresh`, { method: "POST" });
  return {
    message: payload.message,
    added: decodeStreets(payload.added as WireStreet[]),
    removedNames: payload.removedNames ?? [],
  };
}

export async function adoptStreetAdditions(
  user: User,
  projectId: string,
  streetIds: string[],
): Promise<{ project: ProjectSummary; adopted: Street[] }> {
  const payload = await authed(user, `/api/street-projects/${projectId}/adopt`, {
    method: "POST",
    body: JSON.stringify({ streetIds }),
  });
  return { project: toSummary(payload.project), adopted: decodeStreets(payload.adopted as WireStreet[]) };
}

/**
 * A route through the streets he ticked — start, all of them, home again.
 *
 * Only ids go up: the geometry is already on the server and it is the copy the
 * project is measured against. No familiarity comes back, because none is
 * asked for.
 */
export type PlannedStreetRoute = {
  name: string;
  /** [lng, lat], the shape every other route in the app travels in. */
  coordinates: [number, number][];
  distanceMeters: number;
  elevationGainMeters?: number;
  streetOrder: string[];
  streetNames: string[];
  streetMeters: number;
};

export async function planStreetRoute(
  user: User,
  projectId: string,
  input: { start: { lat: number; lng: number }; streetIds: string[] },
): Promise<PlannedStreetRoute> {
  const payload = await authed(user, `/api/street-projects/${projectId}/plan-route`, {
    method: "POST",
    body: JSON.stringify({ start: input.start, streetIds: input.streetIds }),
  });

  const route = payload.route ?? {};
  return {
    name: String(route.name ?? "Street route"),
    coordinates: (route.geometry ?? []) as [number, number][],
    distanceMeters: Number(route.distanceMeters ?? 0),
    elevationGainMeters: Number.isFinite(route.elevationGainMeters) ? Number(route.elevationGainMeters) : undefined,
    streetOrder: (route.streetOrder ?? []).map(String),
    streetNames: (route.streetNames ?? []).map(String),
    streetMeters: Number(route.streetMeters ?? 0),
  };
}

export async function findBoundaries(user: User, lat: number, lng: number): Promise<BoundaryCandidate[]> {
  const payload = await authed(user, `/api/street-projects/boundaries?lat=${lat}&lng=${lng}`);
  return payload.candidates ?? [];
}

export function scopeToRequest(scope: StreetScope): ScopeRequest {
  if (scope.source.kind === "circle") {
    return {
      kind: "circle",
      lat: scope.source.center.lat,
      lng: scope.source.center.lng,
      radiusMeters: scope.source.radiusMeters,
    };
  }
  return { kind: "stored", scope: encodeScope(scope) };
}

/**
 * Street lists in the browser, keyed by project and snapshot.
 *
 * The snapshot timestamp is part of the key, so adopting new streets naturally
 * invalidates the cache while an unchanged project is never downloaded twice.
 */
const CACHE_PREFIX = "gpx-street-project:2";

/**
 * A street list is only worth as much as the count the server agrees with.
 *
 * Adding a street by tapping it does not move `snapshotTakenAt` — the snapshot
 * is still the one OSM handed over, he has only added to it — so the cache key
 * does not change either. That is fine when the rewrite lands and fatal when
 * it does not: the previous list stays under the same key and is then trusted
 * forever, which is exactly what happened. Streets he had added were in
 * Firestore, the project said so when he tried to add them again, and the list
 * on screen was the one from before.
 *
 * The project summary already carries `streetCount`. Comparing it costs
 * nothing and turns a silent wrong answer into one extra fetch.
 */
export function cachedStreets(
  projectId: string,
  snapshotTakenAt: string,
  expectedCount?: number,
): Street[] | null {
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}:${projectId}:${snapshotTakenAt}`);
    if (!raw) return null;

    const wire = JSON.parse(raw) as WireStreet[];
    if (expectedCount !== undefined && wire.length !== expectedCount) {
      localStorage.removeItem(`${CACHE_PREFIX}:${projectId}:${snapshotTakenAt}`);
      return null;
    }

    return decodeStreets(wire);
  } catch {
    return null;
  }
}

/**
 * Roughly what a browser will take before it starts throwing.
 *
 * `useRoutes` has had a cap and a degradation ladder for a while; this write,
 * which is the largest single thing this app stores, had neither. A town of
 * eight hundred streets with geometry runs to megabytes, and `setItem` then
 * throws `QuotaExceededError` — leaving the *previous* value in place, which
 * is worse than leaving nothing.
 */
const STREET_CACHE_MAX_BYTES = 4_000_000;

export function cacheStreets(projectId: string, snapshotTakenAt: string, wire: WireStreet[]): void {
  const key = `${CACHE_PREFIX}:${projectId}:${snapshotTakenAt}`;
  try {
    const payload = JSON.stringify(wire);

    // Too big to store is a reason to hold nothing, never a reason to keep
    // what was there. A stale list that outlives the street he just added is
    // the one failure this cache must not have.
    if (payload.length > STREET_CACHE_MAX_BYTES) {
      localStorage.removeItem(key);
      return;
    }

    localStorage.setItem(key, payload);
  } catch {
    // Same rule on a quota error: drop it and pay for one download.
    try {
      localStorage.removeItem(key);
    } catch {
      // Nothing left to try; the count check on read is the backstop.
    }
  }
}
