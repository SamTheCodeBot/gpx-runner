import { NextRequest, NextResponse } from "next/server";

import { encodeScope } from "@/engine/streets/serialize";
import { scopeAreaKm2 } from "@/engine/streets/scope";
import { fetchBoundaryScope } from "@/lib/overpass";
import { fetchBoundaryCandidates, overpassErrorResponse, requireUid, MAX_SCOPE_AREA_KM2 } from "../shared";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The administrative areas a point falls inside, smallest first.
 *
 * Offered as an alternative to a radius when one of a sensible size exists —
 * "the town" is a truer project than "3 km around my house", and its edge is
 * one somebody else already agreed on. The app deliberately does not try to
 * work out what each level *means*: the owner picks one and the street count
 * tells him whether he picked the town or the whole kommun.
 */
export async function GET(req: NextRequest) {
  const uid = await requireUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const lat = Number(req.nextUrl.searchParams.get("lat"));
  const lng = Number(req.nextUrl.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "A point is needed" }, { status: 400 });
  }

  try {
    const candidates = await fetchBoundaryCandidates({ lat, lng });
    return NextResponse.json({ candidates });
  } catch (error) {
    return overpassErrorResponse(error);
  }
}

/** The outline of one chosen boundary, as the same ring everything else uses. */
export async function POST(req: NextRequest) {
  const uid = await requireUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const scope = await fetchBoundaryScope({
      osmId: Number(body?.osmId),
      name: String(body?.name ?? "Boundary"),
      adminLevel: Number(body?.adminLevel) || 0,
    });

    if (!scope) return NextResponse.json({ error: "That boundary has no usable outline in OSM" }, { status: 400 });

    const areaKm2 = Math.round(scopeAreaKm2(scope) * 10) / 10;
    return NextResponse.json({
      scope: encodeScope(scope),
      areaKm2,
      tooLarge: areaKm2 > MAX_SCOPE_AREA_KM2,
    });
  } catch (error) {
    return overpassErrorResponse(error);
  }
}
