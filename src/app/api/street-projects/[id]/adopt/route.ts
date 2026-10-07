import { NextRequest, NextResponse } from "next/server";

import { encodeStreets } from "@/engine/streets/serialize";
import { adoptPendingAdditions } from "@/lib/streetProjects";
import { requireUid, toWireProject } from "../../shared";

export const dynamic = "force-dynamic";

/**
 * Add the streets the owner chose to the project.
 *
 * Explicit, itemised and opt-in: the streets arrive by id, from a list he has
 * just read. Adopting all of them is one tap, adopting none of them is the
 * default, and either way the denominator only ever changes here.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const uid = await requireUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const streetIds = Array.isArray(body?.streetIds) ? body.streetIds.map(String) : [];
  if (streetIds.length === 0) return NextResponse.json({ error: "No streets chosen" }, { status: 400 });

  const result = await adoptPendingAdditions(uid, params.id, streetIds);
  if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    project: toWireProject(result.project),
    adopted: encodeStreets(result.adopted),
  });
}
