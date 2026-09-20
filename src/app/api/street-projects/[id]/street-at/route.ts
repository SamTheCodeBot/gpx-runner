import { NextRequest, NextResponse } from "next/server";

import { findNearbyStreets } from "@/engine/streets/nearby";
import { NAMED_STREET_RADIUS_METERS, streetAtPoint, wayAtPoint } from "@/engine/streets/pointStreet";
import { encodeStreets } from "@/engine/streets/serialize";
import { fetchNamedWaysNear, fetchWaysAtPoint } from "@/lib/overpass";
import { addStreetsToProject, loadProject } from "@/lib/streetProjects";
import { overpassErrorResponse, requestDeadline, requireUid } from "../../shared";
import type { LatLng } from "@/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Point at a road, and put it in the project.
 *
 * This is the local answer to a local problem. Widening the project area and
 * inventorying the band around it asks a global question — "everything within
 * 2 km" — to solve "I want that road there", and pays for it with a query big
 * enough to time out on the platform. A tap is two small queries: what is under
 * the finger, and the rest of the street it belongs to.
 *
 * POST names the street without changing anything. PUT adds it. The point goes
 * up both times and the geometry is re-derived server-side each time, because
 * the street list is the contract behind every percentage and a client that
 * could post geometry could post a 40 km street it had already run.
 */

/** Widened by the client for a coarse zoom; bounded so a tap stays a tap. */
const MIN_TOLERANCE_METERS = 10;
const MAX_TOLERANCE_METERS = 120;

type Resolved = {
  street: NonNullable<ReturnType<typeof streetAtPoint>>;
  kind: "addition" | "extension" | "already_in_project";
  replacesId?: string;
  wasMeters?: number;
  nowMeters?: number;
};

function pointFrom(body: any): LatLng | null {
  const lat = Number(body?.lat);
  const lng = Number(body?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function toleranceFrom(body: any): number {
  const raw = Number(body?.toleranceMeters);
  if (!Number.isFinite(raw)) return 30;
  return Math.min(MAX_TOLERANCE_METERS, Math.max(MIN_TOLERANCE_METERS, Math.round(raw)));
}

/**
 * Finger to street, then street to verdict.
 *
 * Shared by both verbs so that what he is shown and what gets stored are
 * produced by the same code. The verdict matters: the same tap can mean "add
 * this street", "the project holds a stub of this street and here is the rest
 * of it", or "you already have all of this one".
 */
async function resolve(
  point: LatLng,
  toleranceMeters: number,
  snapshot: Awaited<ReturnType<typeof loadProject>>,
): Promise<Resolved | null> {
  if (!snapshot) return null;
  const deadlineAt = requestDeadline();

  const here = await fetchWaysAtPoint(point, Math.max(toleranceMeters, 25), { deadlineAt });
  const tapped = wayAtPoint(here, point, toleranceMeters);
  if (!tapped) return null;

  const named = await fetchNamedWaysNear(point, tapped.name, NAMED_STREET_RADIUS_METERS, { deadlineAt });
  const street = streetAtPoint(named, point, { toleranceMeters });
  if (!street) return null;

  // The same comparison the "streets the area missed" panel uses, so one tap
  // and a wider look can never disagree about what the project already holds.
  const nearby = findNearbyStreets(snapshot.streets, [street]);

  if (nearby.extensions.length > 0) {
    const extension = nearby.extensions[0];
    return {
      street: extension.street,
      kind: "extension",
      replacesId: extension.replacesId,
      wasMeters: extension.wasMeters,
      nowMeters: extension.nowMeters,
    };
  }

  if (nearby.additions.length > 0) return { street, kind: "addition" };
  return { street, kind: "already_in_project" };
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const uid = await requireUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const loaded = await loadProject(uid, params.id);
  if (!loaded) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const point = pointFrom(body);
  if (!point) return NextResponse.json({ error: "That is not a point on the map" }, { status: 400 });

  try {
    const resolved = await resolve(point, toleranceFrom(body), loaded);
    if (!resolved) {
      return NextResponse.json({ error: "No named runnable street there. Try tapping the road itself." }, { status: 404 });
    }

    return NextResponse.json({
      kind: resolved.kind,
      street: encodeStreets([resolved.street])[0],
      name: resolved.street.name,
      lengthMeters: Math.round(resolved.street.lengthMeters),
      replacesId: resolved.replacesId,
      wasMeters: resolved.wasMeters,
      nowMeters: resolved.nowMeters,
    });
  } catch (error) {
    return overpassErrorResponse(error);
  }
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const uid = await requireUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const loaded = await loadProject(uid, params.id);
  if (!loaded) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const point = pointFrom(body);
  if (!point) return NextResponse.json({ error: "That is not a point on the map" }, { status: 400 });

  try {
    // Re-resolved rather than taken on trust. The Overpass answer is cached by
    // the POST that showed him the name, so this is the same street he agreed to.
    const resolved = await resolve(point, toleranceFrom(body), loaded);
    if (!resolved) {
      return NextResponse.json({ error: "No named runnable street there." }, { status: 404 });
    }

    if (resolved.kind === "already_in_project") {
      return NextResponse.json(
        { error: `${resolved.street.name} is already in this project.`, code: "already_in_project" },
        { status: 409 },
      );
    }

    const chosen =
      resolved.kind === "extension"
        ? {
            additions: [],
            extensions: [
              {
                street: resolved.street,
                replacesId: resolved.replacesId!,
                wasMeters: resolved.wasMeters ?? 0,
                nowMeters: resolved.nowMeters ?? 0,
              },
            ],
          }
        : { additions: [resolved.street], extensions: [] };

    const result = await addStreetsToProject(uid, params.id, chosen);
    if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });

    return NextResponse.json({
      project: { ...result.project, scope: undefined, ownerUid: undefined },
      streets: encodeStreets(result.streets),
      addedCount: result.addedCount,
      kind: resolved.kind,
      name: resolved.street.name,
    });
  } catch (error) {
    return overpassErrorResponse(error);
  }
}
