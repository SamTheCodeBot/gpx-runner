import { NextRequest, NextResponse } from "next/server";

import { encodeScope, encodeStreets } from "@/engine/streets/serialize";
import { createProject, listProjects } from "@/lib/streetProjects";
import {
  inventoryForScope,
  overpassErrorResponse,
  parseScopeInput,
  requestDeadline,
  requireUid,
  resolveScope,
} from "./shared";

export const dynamic = "force-dynamic";
// Hobby kills a function at 60 s whatever a larger number here claims, so claim
// what we actually get and keep our own deadline below it.
export const maxDuration = 60;

/** Every project the owner has, archived ones last. */
export async function GET(req: NextRequest) {
  const uid = await requireUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const projects = await listProjects(uid);
  return NextResponse.json({
    projects: projects.map((project) => ({ ...project, scope: encodeScope(project.scope), ownerUid: undefined })),
  });
}

/**
 * Create a project: an area, a name, and the street list frozen on the spot.
 *
 * Creation is deliberately one request. He lives in one town, works in another
 * and turns up in Frankfurt twice a year — a wizard would mean he only ever
 * makes the first project. A pin, a radius and a name is the whole ceremony.
 *
 * The street list is snapshotted here, once, and never recomputed on its own:
 * that snapshot is the denominator behind every percentage this project will
 * ever show him.
 */
export async function POST(req: NextRequest) {
  const uid = await requireUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const scope = await resolveScope(parseScopeInput(body));
    const inventory = await inventoryForScope(scope, { deadlineAt: requestDeadline() });

    if (inventory.streets.length === 0) {
      return NextResponse.json(
        { error: "OSM has no named streets in that area — try a larger radius or a different spot." },
        { status: 400 },
      );
    }

    const fallbackName =
      scope.source.kind === "boundary" ? scope.source.name : "Street project";
    const name = String(body?.name ?? "").trim().slice(0, 80) || fallbackName;

    const project = await createProject({
      ownerUid: uid,
      name,
      scope,
      streets: inventory.streets,
      wayCount: inventory.wayCount,
    });

    // The street list comes back with the project so the client can show the
    // owner what his existing runs already cover without a second round trip.
    // A project that opened at 0% would be telling him his 1,458 km never
    // happened.
    return NextResponse.json({
      project: { ...project, scope: encodeScope(project.scope), ownerUid: undefined },
      streets: encodeStreets(inventory.streets),
    });
  } catch (error) {
    return overpassErrorResponse(error);
  }
}
