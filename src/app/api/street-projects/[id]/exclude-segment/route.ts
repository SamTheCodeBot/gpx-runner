import { NextRequest, NextResponse } from "next/server";

import { encodeScope } from "@/engine/streets/serialize";
import { addExcludedSegment, removeExcludedSegment } from "@/lib/streetProjects";
import { requireUid } from "../../shared";
import type { LatLng } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Strike one stretch of a street off, or put it back.
 *
 * The sibling of `/exclude`, at a finer grain: that route takes a street whole,
 * this one takes the exact geometry the client is already holding — the
 * `missing` lines a focused street draws in red. There is nowhere safer to get
 * that shape from than the same coverage walk the percentage itself comes
 * from, so the points go up rather than being re-derived here from a tap and a
 * tolerance.
 */

function piecesFrom(body: any): LatLng[][] | null {
  if (!Array.isArray(body?.pieces)) return null;
  const pieces: LatLng[][] = [];
  for (const piece of body.pieces) {
    if (!Array.isArray(piece)) return null;
    const points: LatLng[] = [];
    for (const point of piece) {
      const lat = Number(point?.lat);
      const lng = Number(point?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      points.push({ lat, lng });
    }
    if (points.length >= 2) pieces.push(points);
  }
  return pieces;
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const uid = await requireUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const streetId = typeof body?.streetId === "string" ? body.streetId : null;
  const pieces = piecesFrom(body);
  const meters = Number(body?.meters);

  if (!streetId || !pieces || pieces.length === 0 || !Number.isFinite(meters) || meters <= 0) {
    return NextResponse.json({ error: "Nothing to strike off there." }, { status: 400 });
  }

  const result = await addExcludedSegment(uid, params.id, { streetId, pieces, meters });
  if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    project: { ...result.project, scope: encodeScope(result.project.scope), ownerUid: undefined },
    segment: result.segment,
  });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const uid = await requireUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const segmentId = typeof body?.segmentId === "string" ? body.segmentId : null;
  if (!segmentId) return NextResponse.json({ error: "No stretch named" }, { status: 400 });

  const project = await removeExcludedSegment(uid, params.id, segmentId);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ project: { ...project, scope: encodeScope(project.scope), ownerUid: undefined } });
}
