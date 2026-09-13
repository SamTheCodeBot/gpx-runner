import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BudgetedProvider, ProviderBudget, resetRouteCache } from "../src/engine/providers/budget";
import {
  MAX_COORDINATES_PER_CALL,
  MAX_SELECTED_STREETS,
  StreetRouteError,
  buildStreetWaypoints,
  legCountForStreets,
  orderStreetsForRoute,
  planStreetRoute,
  splitIntoLegs,
} from "../src/engine/streets/streetRoute";
import type { Street } from "../src/engine/streets/inventory";
import { destinationPoint, haversineMeters, polylineDistanceMeters } from "../src/engine/utils/geo";
import { FALKENBERG_HOME } from "./helpers/denseHistory";
import { gridRouter } from "./helpers/gridRouter";
import type { LatLng, RouteProvider } from "../src/types";

/**
 * "Just a start point and go through those checked streets and back again."
 *
 * Two things have to hold. The order has to be a runner's order rather than the
 * order he happened to tick the boxes in, and every metre of the line has to
 * come from the router — a straight join between two streets is a run through
 * somebody's garden.
 */

const HOME: LatLng = FALKENBERG_HOME;

/** A street `offsetMeters` away on `offsetBearing`, running north for `lengthMeters`. */
function streetAt(id: string, offsetBearing: number, offsetMeters: number, lengthMeters = 200): Street {
  const from = destinationPoint(HOME, offsetBearing, offsetMeters);
  const geometry: LatLng[] = [];
  const steps = 4;
  for (let i = 0; i <= steps; i += 1) geometry.push(destinationPoint(from, 0, (lengthMeters * i) / steps));

  return {
    id,
    name: id,
    part: 0,
    wayIds: [1],
    geometry: [geometry],
    lengthMeters: polylineDistanceMeters(geometry),
  };
}

/** What the joining-up costs: the bits between the streets, and the walk home. */
function connectorMeters(start: LatLng, legs: ReturnType<typeof orderStreetsForRoute>["legs"]): number {
  let total = 0;
  let cursor = start;
  for (const leg of legs) {
    total += haversineMeters(cursor, leg.entry);
    cursor = leg.exit;
  }
  return total + haversineMeters(cursor, start);
}

function costOfListOrder(start: LatLng, streets: Street[]): number {
  let total = 0;
  let cursor = start;
  for (const street of streets) {
    const piece = street.geometry[0];
    total += haversineMeters(cursor, piece[0]);
    cursor = piece[piece.length - 1];
  }
  return total + haversineMeters(cursor, start);
}

function manyStreets(count: number): Street[] {
  return Array.from({ length: count }, (_, i) => streetAt(`S${i}`, (i * 37) % 360, 300 + (i % 7) * 120));
}

/** A provider that answers nothing, to prove nothing is invented when it does. */
const silentProvider: RouteProvider = {
  async route() {
    return null;
  },
};

describe("ordering the checked streets", () => {
  it("visits them from the start point outwards, not in the order they were ticked", () => {
    const streets = [streetAt("far", 90, 2000), streetAt("near", 90, 500), streetAt("mid", 90, 1200)];

    const { order } = orderStreetsForRoute(HOME, streets);

    assert.deepEqual(
      order.map((street) => street.id),
      ["near", "mid", "far"],
    );
  });

  it("un-zigzags an order that crosses town between every street", () => {
    // Ticked down the list, this alternates east and west of the start: the
    // exact shape the ask called out as the thing to avoid.
    const zigzag = [
      streetAt("east-1", 90, 900),
      streetAt("west-1", 270, 900),
      streetAt("east-2", 90, 1500),
      streetAt("west-2", 270, 1500),
    ];

    const { legs } = orderStreetsForRoute(HOME, zigzag);

    const routed = connectorMeters(HOME, legs);
    const asTicked = costOfListOrder(HOME, zigzag);
    assert.ok(
      routed < asTicked * 0.7,
      `ordering should cut the joining-up well below the ticked order (${Math.round(routed)} m vs ${Math.round(asTicked)} m)`,
    );
  });

  it("comes back to the start", () => {
    const { legs } = orderStreetsForRoute(HOME, manyStreets(8));
    const waypoints = buildStreetWaypoints(HOME, legs);

    assert.deepEqual(waypoints[0], HOME);
    assert.deepEqual(waypoints[waypoints.length - 1], HOME);
  });

  it("asks for both ends and the middle of every street", () => {
    const streets = manyStreets(5);
    const { legs } = orderStreetsForRoute(HOME, streets);
    const waypoints = buildStreetWaypoints(HOME, legs);

    assert.equal(waypoints.length, 5 * 3 + 2);
  });

  it("skips streets with no usable geometry rather than routing through nowhere", () => {
    const broken: Street = { ...streetAt("broken", 45, 600), geometry: [[]] };
    const { order } = orderStreetsForRoute(HOME, [streetAt("good", 90, 500), broken]);

    assert.deepEqual(
      order.map((street) => street.id),
      ["good"],
    );
  });
});

describe("fitting the request into what the provider accepts", () => {
  it("keeps every call inside the 50-coordinate limit", () => {
    const waypoints = buildStreetWaypoints(HOME, orderStreetsForRoute(HOME, manyStreets(MAX_SELECTED_STREETS)).legs);
    const legs = splitIntoLegs(waypoints);

    assert.equal(waypoints.length, MAX_SELECTED_STREETS * 3 + 2);
    for (const leg of legs) {
      assert.ok(leg.length <= MAX_COORDINATES_PER_CALL, `leg of ${leg.length} coordinates`);
      assert.ok(leg.length >= 2);
    }
  });

  it("hands consecutive calls the waypoint they meet at", () => {
    const waypoints = Array.from({ length: 122 }, (_, i) => destinationPoint(HOME, i * 3, 100 + i));
    const legs = splitIntoLegs(waypoints);

    assert.equal(legs.length, 3);
    for (let i = 1; i < legs.length; i += 1) {
      assert.deepEqual(legs[i][0], legs[i - 1][legs[i - 1].length - 1], "a seam waypoint is shared, not skipped");
    }
    // Nothing lost in the middle: the legs reassemble into the original list.
    const rejoined = legs.flatMap((leg, i) => (i === 0 ? leg : leg.slice(1)));
    assert.deepEqual(rejoined, waypoints);
  });

  it("a full selection stays well inside the shared provider budget", () => {
    assert.equal(legCountForStreets(MAX_SELECTED_STREETS), 3);
    assert.ok(legCountForStreets(MAX_SELECTED_STREETS) < new ProviderBudget().limit);
  });
});

describe("planning the route", () => {
  it("returns provider-drawn geometry, never a straight line between streets", async () => {
    resetRouteCache();
    const router = gridRouter();
    const streets = [streetAt("a", 90, 600), streetAt("b", 180, 700), streetAt("c", 320, 800)];

    const plan = await planStreetRoute(router, { start: HOME, streets, deadlineAt: Date.now() + 20_000 });

    assert.equal(router.calls.length, 1, "three streets fit in one call");
    assert.ok(plan.geometry.length > 50, "a routed line has far more points than its waypoints");
    assert.equal(plan.legCount, 1);
    assert.deepEqual(plan.streetOrder.slice().sort(), ["a", "b", "c"]);

    // The grid router walks streets; a straight join would be the crow-flies
    // distance. Anything routed is longer than the straight line through the
    // same waypoints, and that gap is the whole point of this feature.
    const waypoints = buildStreetWaypoints(HOME, orderStreetsForRoute(HOME, streets).legs);
    assert.ok(
      plan.distanceMeters > polylineDistanceMeters(waypoints),
      "routed distance exceeds the straight-line path through the waypoints",
    );

    assert.ok(haversineMeters(plan.geometry[plan.geometry.length - 1], HOME) < 150, "it ends back at the start");
  });

  it("stitches multi-call routes without a gap or a doubled point", async () => {
    resetRouteCache();
    const router = gridRouter();
    const streets = manyStreets(MAX_SELECTED_STREETS);

    const plan = await planStreetRoute(router, { start: HOME, streets, deadlineAt: Date.now() + 30_000 });

    assert.equal(plan.legCount, 3);
    assert.equal(router.calls.length, 3);
    assert.equal(plan.streetOrder.length, MAX_SELECTED_STREETS);

    for (let i = 1; i < plan.geometry.length; i += 1) {
      const step = haversineMeters(plan.geometry[i - 1], plan.geometry[i]);
      assert.ok(step > 0, "no doubled point where two calls meet");
      assert.ok(step < 200, `no jump across the seam (${Math.round(step)} m at index ${i})`);
    }
  });

  it("refuses more streets than one route may cover, instead of quietly dropping some", async () => {
    const streets = manyStreets(MAX_SELECTED_STREETS + 1);

    await assert.rejects(
      () => planStreetRoute(gridRouter(), { start: HOME, streets }),
      (error: unknown) => {
        assert.ok(error instanceof StreetRouteError);
        assert.equal(error.code, "too-many-streets");
        assert.match(error.message, /you picked 41/);
        return true;
      },
    );
  });

  it("refuses an empty selection", async () => {
    await assert.rejects(
      () => planStreetRoute(gridRouter(), { start: HOME, streets: [] }),
      (error: unknown) => error instanceof StreetRouteError && error.code === "no-streets",
    );
  });

  it("fails loudly when the provider will not draw it", async () => {
    await assert.rejects(
      () => planStreetRoute(silentProvider, { start: HOME, streets: [streetAt("a", 90, 500)] }),
      (error: unknown) => {
        assert.ok(error instanceof StreetRouteError, "no half-drawn route escapes");
        return true;
      },
    );
  });

  it("stops at the shared budget rather than inventing the rest", async () => {
    resetRouteCache();
    const budget = new ProviderBudget(1);
    const budgeted = new BudgetedProvider(gridRouter(), budget);

    await assert.rejects(
      () =>
        planStreetRoute(budgeted, {
          start: HOME,
          streets: manyStreets(MAX_SELECTED_STREETS),
          deadlineAt: Date.now() + 30_000,
        }),
      (error: unknown) => {
        assert.ok(error instanceof StreetRouteError);
        assert.equal(error.code, "budget-exhausted");
        return true;
      },
    );

    assert.equal(budget.calls, 1, "it spent the purse and stopped");
  });

  it("gives up on the clock before the platform does", async () => {
    const slow = gridRouter({ delayMs: 20 });

    await assert.rejects(
      () =>
        planStreetRoute(slow, {
          start: HOME,
          streets: manyStreets(MAX_SELECTED_STREETS),
          deadlineAt: Date.now() - 1,
        }),
      (error: unknown) => {
        assert.ok(error instanceof StreetRouteError);
        assert.equal(error.code, "out-of-time");
        return true;
      },
    );
  });
});
