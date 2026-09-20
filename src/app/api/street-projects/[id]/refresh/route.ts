import { NextRequest, NextResponse } from "next/server";

import { describeInventoryDiff, diffInventories } from "@/engine/streets/snapshot";
import { encodeStreets } from "@/engine/streets/serialize";
import { loadProject, savePendingAdditions } from "@/lib/streetProjects";
import { inventoryForScope, overpassErrorResponse, requireUid } from "../../shared";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Ask OSM what has changed — and change nothing.
 *
 * This is the endpoint behind the trust problem. OSM gains streets every week.
 * If the project recomputed its list here, a new estate mapped on Tuesday would
 * enlarge the denominator and the owner's percentage would *fall* after a run
 * he did nothing wrong on. So a refresh only ever reports: it writes the
 * additions to one side, names them, and waits. The number moves when he says
 * it moves, and when it does he already knows which streets did it.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const uid = await requireUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const loaded = await loadProject(uid, params.id);
  if (!loaded) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    // Force a real read: the point of pressing refresh is to bypass the week-long
    // cache that every other call is happy with.
    const inventory = await inventoryForScope(loaded.project.scope, { maxAgeMs: 60 * 60 * 1000 });
    const diff = diffInventories(loaded.streets, inventory.streets);

    // A refresh reads inside the scope only. Streets the owner deliberately let
    // in from outside it are therefore absent from this inventory by
    // definition, and reporting them as "no longer in OSM" would be the app
    // arguing with a decision he made on purpose.
    const addedFromOutside = new Set(loaded.project.addedStreetIds);
    const removed = diff.removed.filter((street) => !addedFromOutside.has(street.id));

    await savePendingAdditions(
      params.id,
      diff.added,
      removed.map((street) => street.name),
    );

    return NextResponse.json({
      message: describeInventoryDiff({ ...diff, removed }),
      added: encodeStreets(diff.added),
      removedNames: removed.map((street) => street.name),
      unchangedCount: diff.unchangedCount,
      // Unchanged on purpose: a refresh never moves the goalposts by itself.
      streetCount: loaded.project.streetCount,
    });
  } catch (error) {
    return overpassErrorResponse(error);
  }
}
