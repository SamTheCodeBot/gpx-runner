import { NextRequest, NextResponse } from "next/server";

import { describeNearby, findNearbyStreets } from "@/engine/streets/nearby";
import { growScope } from "@/engine/streets/scope";
import { encodeStreets } from "@/engine/streets/serialize";
import { addStreetsToProject, loadProject } from "@/lib/streetProjects";
import { inventoryForScope, overpassErrorResponse, requireUid } from "../../shared";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * What is just outside the project area.
 *
 * The circle was always a guess, and this is how the guess gets corrected
 * without throwing the project away. GET-shaped but POSTed, because it takes a
 * margin and it costs an Overpass read.
 *
 * Nothing is stored. Widening the look is free; widening the project is a
 * decision, and that is the other endpoint.
 */

/** Far enough to catch the estate over the roundabout, near enough to stay a list. */
const DEFAULT_MARGIN_METERS = 750;
const MAX_MARGIN_METERS = 3000;
/** A margin around a kommun would return a county. The owner picks streets, not regions. */
const MAX_CANDIDATES = 400;

function marginFrom(body: unknown): number {
  const raw = Number((body as { marginMeters?: unknown })?.marginMeters);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MARGIN_METERS;
  return Math.min(MAX_MARGIN_METERS, Math.max(100, Math.round(raw)));
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const uid = await requireUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const loaded = await loadProject(uid, params.id);
  if (!loaded) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const marginMeters = marginFrom(body);

  try {
    const wider = await inventoryForScope(growScope(loaded.project.scope, marginMeters));
    const nearby = findNearbyStreets(loaded.streets, wider.streets);

    // Streets he already let in sit outside the project scope, so a wider read
    // finds them again every time. They are in the snapshot; they are not news.
    const held = new Set(loaded.streets.map((street) => street.id));
    const additions = nearby.additions.filter((street) => !held.has(street.id)).slice(0, MAX_CANDIDATES);

    return NextResponse.json({
      marginMeters,
      message: describeNearby({ additions, extensions: nearby.extensions }),
      additions: encodeStreets(additions),
      extensions: nearby.extensions.slice(0, MAX_CANDIDATES).map((extension) => ({
        replacesId: extension.replacesId,
        wasMeters: extension.wasMeters,
        nowMeters: extension.nowMeters,
        street: encodeStreets([extension.street])[0],
      })),
      truncated: nearby.additions.length > MAX_CANDIDATES,
    });
  } catch (error) {
    return overpassErrorResponse(error);
  }
}

/**
 * Let the chosen ones in.
 *
 * The ids are resolved against a fresh read of the same widened area rather
 * than against geometry posted by the browser: the street list is the contract
 * behind every percentage, and a client that could hand us geometry could hand
 * us a 40 km street it had already run.
 */
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const uid = await requireUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const loaded = await loadProject(uid, params.id);
  if (!loaded) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const marginMeters = marginFrom(body);
  const wanted = new Set(
    Array.isArray(body?.streetIds)
      ? body.streetIds.filter((id: unknown): id is string => typeof id === "string")
      : [],
  );

  if (wanted.size === 0) return NextResponse.json({ error: "No streets named" }, { status: 400 });

  try {
    // Cached by the call that listed them, so this is the same map the owner
    // was looking at when he picked.
    const wider = await inventoryForScope(growScope(loaded.project.scope, marginMeters));
    const nearby = findNearbyStreets(loaded.streets, wider.streets);

    const additions = nearby.additions.filter((street) => wanted.has(street.id));
    const extensions = nearby.extensions.filter(
      (extension) => wanted.has(extension.street.id) || wanted.has(extension.replacesId),
    );

    if (additions.length === 0 && extensions.length === 0) {
      return NextResponse.json({ error: "Those streets are no longer there to add" }, { status: 409 });
    }

    const result = await addStreetsToProject(uid, params.id, { additions, extensions });
    if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });

    return NextResponse.json({
      project: { ...result.project, scope: undefined, ownerUid: undefined },
      streets: encodeStreets(result.streets),
      addedCount: result.addedCount,
    });
  } catch (error) {
    return overpassErrorResponse(error);
  }
}
