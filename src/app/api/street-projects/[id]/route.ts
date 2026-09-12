import { NextRequest, NextResponse } from "next/server";

import { encodeScope, encodeStreets } from "@/engine/streets/serialize";
import { loadPendingAdditions, loadProject, updateProject } from "@/lib/streetProjects";
import { requireUid } from "../shared";

export const dynamic = "force-dynamic";

/** One project, its frozen street list, and anything OSM has gained since. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const uid = await requireUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const loaded = await loadProject(uid, params.id);
  if (!loaded) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const pending = await loadPendingAdditions(uid, params.id);

  return NextResponse.json({
    project: { ...loaded.project, scope: encodeScope(loaded.project.scope), ownerUid: undefined },
    streets: encodeStreets(loaded.streets),
    pending: {
      foundAt: pending.foundAt,
      streets: encodeStreets(pending.streets),
      removedNames: pending.removedNames,
    },
  });
}

/**
 * Rename, or archive.
 *
 * There is no delete. A project is months of a person's running life, and the
 * one thing worse than a stalled project is a stalled project he tapped away by
 * accident.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const uid = await requireUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const project = await updateProject(uid, params.id, {
    name: typeof body?.name === "string" ? body.name : undefined,
    archived: typeof body?.archived === "boolean" ? body.archived : undefined,
  });

  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ project: { ...project, scope: encodeScope(project.scope), ownerUid: undefined } });
}
