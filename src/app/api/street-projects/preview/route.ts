import { NextRequest, NextResponse } from "next/server";

import { encodeScope } from "@/engine/streets/serialize";
import { scopeAreaKm2 } from "@/engine/streets/scope";
import {
  inventoryForScope,
  overpassErrorResponse,
  parseScopeInput,
  requireUid,
  resolveScope,
} from "../shared";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * "3 km around here is 614 streets."
 *
 * The safety check that stops a project being drawn around a whole kommun by
 * accident. Falkenberg kommun contains Ullared — a different town forty
 * kilometres away — and no amount of reasoning about Swedish administrative
 * semantics would tell the owner that. The street count does, instantly, before
 * anything is created.
 *
 * It is the same code path that will build the project: same query, same
 * grouping, same clipping. A preview that was computed some cheaper way would
 * be a different number, and then the first thing the feature ever said to him
 * would have been a lie.
 */
export async function POST(req: NextRequest) {
  const uid = await requireUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const scope = await resolveScope(parseScopeInput(body));
    const inventory = await inventoryForScope(scope);

    const longest = [...inventory.streets]
      .sort((a, b) => b.lengthMeters - a.lengthMeters)
      .slice(0, 5)
      .map((street) => street.name);

    return NextResponse.json({
      streetCount: inventory.streets.length,
      wayCount: inventory.wayCount,
      totalMeters: Math.round(inventory.totalMeters),
      areaKm2: Math.round(scopeAreaKm2(scope) * 10) / 10,
      longestStreets: longest,
      scope: encodeScope(scope),
    });
  } catch (error) {
    return overpassErrorResponse(error);
  }
}
