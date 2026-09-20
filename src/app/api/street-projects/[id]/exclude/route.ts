import { NextRequest, NextResponse } from "next/server";

import { encodeScope } from "@/engine/streets/serialize";
import { setStreetExclusions } from "@/lib/streetProjects";
import { requireUid } from "../../shared";

export const dynamic = "force-dynamic";

/**
 * Strike a street off this project, or put it back.
 *
 * A POST rather than a PATCH on the project, because the street list is not in
 * the project document and this is a statement about the list: "these ones do
 * not count". It takes an array so the client can undo a batch in one call and
 * so ticking six roads along one motorway feeder is one request, not six.
 *
 * Nothing is deleted. The street stays in the snapshot with its geometry, which
 * is what makes putting it back a tap rather than a refresh.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const uid = await requireUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const streetIds = Array.isArray(body?.streetIds)
    ? body.streetIds.filter((id: unknown): id is string => typeof id === "string")
    : [];

  if (streetIds.length === 0) {
    return NextResponse.json({ error: "No streets named" }, { status: 400 });
  }

  const result = await setStreetExclusions(uid, params.id, {
    streetIds,
    excluded: body?.excluded !== false,
  });

  if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    project: { ...result.project, scope: encodeScope(result.project.scope), ownerUid: undefined },
    excludedStreetIds: result.excludedStreetIds,
  });
}
