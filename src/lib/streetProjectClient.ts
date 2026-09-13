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

export function cachedStreets(projectId: string, snapshotTakenAt: string): Street[] | null {
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}:${projectId}:${snapshotTakenAt}`);
    if (!raw) return null;
    return decodeStreets(JSON.parse(raw) as WireStreet[]);
  } catch {
    return null;
  }
}

export function cacheStreets(projectId: string, snapshotTakenAt: string, wire: WireStreet[]): void {
  try {
    localStorage.setItem(`${CACHE_PREFIX}:${projectId}:${snapshotTakenAt}`, JSON.stringify(wire));
  } catch {
    // A full quota costs one extra download, nothing more.
  }
}
