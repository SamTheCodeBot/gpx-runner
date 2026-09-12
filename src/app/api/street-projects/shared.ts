import { NextRequest, NextResponse } from "next/server";

import { buildStreetInventory, type StreetInventory } from "@/engine/streets/inventory";
import { circleScope, scopeAreaKm2, type StreetScope } from "@/engine/streets/scope";
import { verifyFirebaseIdToken } from "@/lib/firebaseAuthServer";
import { OverpassError, fetchBoundaryCandidates, fetchBoundaryScope, fetchStreetWays } from "@/lib/overpass";
import { decodeScope, type WireScope } from "@/engine/streets/serialize";

/**
 * The bits every street-project endpoint needs: who is asking, what area they
 * mean, and what streets are in it.
 *
 * Scope resolution lives here rather than in each route because a circle and an
 * administrative boundary have to become the *same* thing — a ring — before any
 * of them looks at it. The only place the two ever differ is the few lines
 * below.
 */

export async function requireUid(req: NextRequest): Promise<string | null> {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  try {
    const token = await verifyFirebaseIdToken(header.slice(7));
    return token.uid;
  } catch {
    return null;
  }
}

export type ScopeInput =
  | { kind: "circle"; lat: number; lng: number; radiusMeters: number }
  | { kind: "boundary"; osmId: number; name?: string; adminLevel?: number }
  | { kind: "stored"; scope: WireScope };

/** A radius a person can run out of: below this it is a street, above it a county. */
export const MIN_RADIUS_METERS = 200;
export const MAX_RADIUS_METERS = 25_000;
/** Guards Overpass, and the owner, against a project the size of a province. */
export const MAX_SCOPE_AREA_KM2 = 2500;

export async function resolveScope(input: ScopeInput): Promise<StreetScope> {
  if (input.kind === "stored") return decodeScope(input.scope);

  if (input.kind === "circle") {
    if (!Number.isFinite(input.lat) || !Number.isFinite(input.lng)) throw new Error("A project needs a point on the map");
    const radius = Math.min(MAX_RADIUS_METERS, Math.max(MIN_RADIUS_METERS, Number(input.radiusMeters) || 3000));
    return circleScope({ lat: input.lat, lng: input.lng }, radius);
  }

  const candidate = {
    osmId: Number(input.osmId),
    name: input.name ?? "Boundary",
    adminLevel: Number(input.adminLevel) || 0,
  };
  const scope = await fetchBoundaryScope(candidate);
  if (!scope) throw new Error("That boundary has no usable outline in OSM");
  return scope;
}

export function parseScopeInput(body: any): ScopeInput {
  const scope = body?.scope ?? body;
  if (scope?.kind === "boundary") {
    return { kind: "boundary", osmId: Number(scope.osmId), name: scope.name, adminLevel: scope.adminLevel };
  }
  if (scope?.kind === "stored" && scope.scope) return { kind: "stored", scope: scope.scope };
  return {
    kind: "circle",
    lat: Number(scope?.lat ?? scope?.center?.lat),
    lng: Number(scope?.lng ?? scope?.center?.lng),
    radiusMeters: Number(scope?.radiusMeters ?? 3000),
  };
}

export async function inventoryForScope(
  scope: StreetScope,
  options: { cachedOnly?: boolean; maxAgeMs?: number } = {},
): Promise<StreetInventory> {
  if (scopeAreaKm2(scope) > MAX_SCOPE_AREA_KM2) {
    throw new OverpassError("That area is too large to inventory in one project", "bad_response");
  }
  const ways = await fetchStreetWays(scope, options);
  return buildStreetInventory(ways, scope);
}

export { fetchBoundaryCandidates };

/** Overpass being busy is a fact about the world, not a bug in the app. */
export function overpassErrorResponse(error: unknown): NextResponse {
  if (error instanceof OverpassError) {
    const status = error.code === "bad_response" ? 400 : 503;
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        retryable: error.code !== "bad_response",
      },
      { status },
    );
  }

  const message = error instanceof Error ? error.message : "Could not read the street map";
  return NextResponse.json({ error: message }, { status: 400 });
}
