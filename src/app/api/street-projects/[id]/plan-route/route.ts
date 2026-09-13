import { NextRequest, NextResponse } from "next/server";

import { BudgetedProvider, ProviderBudget } from "@/engine/providers/budget";
import { OpenRouteServiceProvider } from "@/engine/providers/openRouteService";
import {
  MAX_SELECTED_STREETS,
  StreetRouteError,
  planStreetRoute,
} from "@/engine/streets/streetRoute";
import { loadProject } from "@/lib/streetProjects";
import { requireUid } from "../../shared";

export const dynamic = "force-dynamic";
// Hobby kills a function at 60 s whatever a larger number here claims, so claim
// what we actually get and keep our own deadline below it.
export const maxDuration = 60;

/**
 * Our own deadline, under the platform's, so a slow router is cut short by us
 * with a sentence he can act on rather than by Vercel with an empty 504.
 *
 * Three directions calls at up to 10 s each is the worst realistic case, so 40 s
 * leaves room for the load and the response and still loses the race to 60 s
 * on purpose.
 */
const REQUEST_BUDGET_MS = 40_000;

/**
 * A route through the streets he ticked.
 *
 * Street geometry is read from the project on this side rather than posted up:
 * it is the authoritative copy, it saves shipping a town's worth of polylines
 * back to the server, and it means the route can only ever cover streets that
 * are really in the project.
 *
 * No familiarity is computed here, by design. He asked for a way round the
 * streets he picked, not an opinion about how well he knows them.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const uid = await requireUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!process.env.OPENROUTESERVICE_API_KEY) {
    return NextResponse.json(
      { error: "Route building is not configured on the server (missing openrouteservice API key)." },
      { status: 503 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const streetIds: string[] = Array.isArray(body?.streetIds) ? body.streetIds.map(String) : [];
  const start = body?.start;

  if (streetIds.length === 0) {
    return NextResponse.json({ error: "Tick at least one street first." }, { status: 400 });
  }
  if (streetIds.length > MAX_SELECTED_STREETS) {
    return NextResponse.json(
      {
        error: `One route can cover ${MAX_SELECTED_STREETS} streets at a time — you picked ${streetIds.length}.`,
        code: "too-many-streets",
      },
      { status: 400 },
    );
  }
  if (!start || !Number.isFinite(Number(start.lat)) || !Number.isFinite(Number(start.lng))) {
    return NextResponse.json({ error: "That route needs a start point." }, { status: 400 });
  }

  const loaded = await loadProject(uid, params.id);
  if (!loaded) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const wanted = new Set(streetIds);
  const streets = loaded.streets.filter((street) => wanted.has(street.id));
  if (streets.length === 0) {
    return NextResponse.json({ error: "None of those streets are in this project." }, { status: 400 });
  }

  // One purse for the click, the same one every other routed feature draws from.
  const budget = new ProviderBudget();
  const provider = new BudgetedProvider(
    new OpenRouteServiceProvider(process.env.OPENROUTESERVICE_API_KEY),
    budget,
  );

  try {
    const plan = await planStreetRoute(provider, {
      start: { lat: Number(start.lat), lng: Number(start.lng) },
      streets,
      routeStyle: body?.routeStyle === "road" || body?.routeStyle === "trail" ? body.routeStyle : "mixed",
      deadlineAt: Date.now() + REQUEST_BUDGET_MS,
    });

    return NextResponse.json({
      route: {
        name: `${loaded.project.name} — ${plan.streetOrder.length} street${
          plan.streetOrder.length === 1 ? "" : "s"
        }`,
        geometry: plan.geometry.map((point) => [point.lng, point.lat]),
        distanceMeters: plan.distanceMeters,
        elevationGainMeters: plan.elevationGainMeters,
        streetOrder: plan.streetOrder,
        streetNames: plan.streetNames,
        streetMeters: plan.streetMeters,
      },
      debug: { ...budget.toDebug(), waypoints: plan.waypointCount, legs: plan.legCount },
    });
  } catch (error) {
    if (error instanceof StreetRouteError) {
      return NextResponse.json(
        { error: error.message, code: error.code, retryable: error.code !== "too-many-streets" },
        { status: error.code === "too-many-streets" || error.code === "no-streets" ? 400 : 503 },
      );
    }
    const message = error instanceof Error ? error.message : "Could not build that route";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
