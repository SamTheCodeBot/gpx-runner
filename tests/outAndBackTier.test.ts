import "./helpers/alias";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { generateRoutes } from "@/engine/generateRoute";
import { SUGGESTION_TIERS, pickByTier } from "@/engine/routeTiers";
import { destinationPoint, maxPointGapMeters, polylineDistanceMeters } from "@/engine/utils/geo";
import type { LatLng, RouteProvider, RouteRequest } from "@/types";
import { radiusForLoopDistance, straightTrack } from "./helpers/geometry";

/**
 * "Sometimes an out and back might be the only solution. But hey, then it is
 * ok. But we should always try to avoid it."
 *
 * Loop shape is therefore no longer a flat refusal — but it is not a scoring
 * weight either, which would let a there-and-back win a close contest. It is an
 * ordered fallback: the out-and-back tier is consulted only once every loop
 * tier above it is empty.
 *
 * The relaxation covers the *shape* of the run and nothing else. Every tier
 * here is still drawn by the routing provider and still checked for road
 * safety; an out-and-back along real streets is a disappointment, a straight
 * line over houses and water is not a route.
 */

const HOME: LatLng = { lat: 56.907, lng: 12.5072 };
const TARGET_KM = 5;
const TARGET_METERS = TARGET_KM * 1_000;

/** A real loop from the door: the door is on the ring, not in the middle. */
const LOOP = (() => {
  const radius = radiusForLoopDistance(TARGET_METERS);
  const centre = destinationPoint(HOME, 0, radius);
  const ring: LatLng[] = [];
  for (let i = 0; i <= 240; i += 1) ring.push(destinationPoint(centre, 180 + (360 / 240) * i, radius));
  return ring;
})();

/** 2.5 km out along one road and back again. Densely sampled: properly routed. */
const OUT_AND_BACK = (() => {
  const out = straightTrack(HOME, 90, 2_500, 20);
  return [...out, ...out.slice(0, -1).reverse()];
})();

function providerReturning(geometry: LatLng[]): RouteProvider & { calls: RouteRequest[] } {
  const calls: RouteRequest[] = [];
  return {
    calls,
    async route(request: RouteRequest) {
      calls.push(request);
      return { geometry, distanceMeters: polylineDistanceMeters(geometry), elevationGainMeters: 30 };
    },
  };
}

const baseInput = {
  start: HOME,
  targetDistanceKm: TARGET_KM,
  familiarityMode: "mixed" as const,
  routeCollections: [] as LatLng[][],
};

describe("the out-and-back tier", () => {
  it("is not used at all when a loop can be found", async () => {
    const result = await generateRoutes(providerReturning(LOOP), baseInput);

    assert.ok(result.routes.length > 0, "a proper loop of the right length must be accepted");
    assert.deepEqual(result.outAndBacks, [], "no there-and-back should even be on the table");
    for (const route of result.routes) assert.equal(route.isOutAndBack, false);
  });

  it("catches the out-and-back when that is all the start point offers", async () => {
    const provider = providerReturning(OUT_AND_BACK);
    const result = await generateRoutes(provider, baseInput);

    assert.deepEqual(result.routes, [], "a there-and-back is never an outright match");
    assert.deepEqual(result.nearMisses, [], "nor a familiarity near miss");
    assert.deepEqual(result.bestEffort, [], "nor a 'closest real loop'");

    assert.ok(result.outAndBacks.length > 0, "but it is kept, because it is better than nothing");
    const [fallback] = result.outAndBacks;
    assert.equal(fallback.isOutAndBack, true, "and it is labelled as what it is");

    // The relaxation is about shape only.
    assert.equal(fallback.routedByProvider, true);
    assert.ok(maxPointGapMeters(fallback.geometry) < 40, "it still has to follow real ways");
    assert.ok(
      Math.abs(fallback.distanceMeters - TARGET_METERS) <= 500,
      "and it still has to be the length that was asked for",
    );
  });

  it("takes the loop, never the out-and-back, when the provider offers both", async () => {
    // The out-and-back comes back first and on most calls, so only the tier
    // order can keep it out of the answer.
    let call = 0;
    const provider: RouteProvider = {
      async route() {
        call += 1;
        const geometry = call % 4 === 0 ? LOOP : OUT_AND_BACK;
        return { geometry, distanceMeters: polylineDistanceMeters(geometry) };
      },
    };

    const result = await generateRoutes(provider, baseInput);

    assert.ok(result.outAndBacks.length > 0, "the fixture must really offer one, or this proves nothing");
    assert.ok(result.routes.length > 0, "and a loop, too");

    const picked = pickByTier({
      "loop-familiarity-matched": result.routes[0],
      "loop-familiarity-missed": result.nearMisses[0],
      "loop-off-distance": result.bestEffort[0],
      "out-and-back": result.outAndBacks[0],
    });

    assert.ok(picked);
    assert.equal(picked.tier.id, "loop-familiarity-matched");
    assert.equal(picked.tier.isOutAndBack, false);
    assert.equal(picked.candidate.isOutAndBack, false);
  });

  it("still refuses an out-and-back down an unsafe road", async () => {
    const provider: RouteProvider = {
      async route() {
        return {
          geometry: OUT_AND_BACK,
          distanceMeters: polylineDistanceMeters(OUT_AND_BACK),
          extras: {
            // A state road for most of its length — the reason road avoidance exists.
            waytype: [{ value: 1, distance: 4_000, amount: 80 }],
            noise: [{ value: 9, distance: 4_000, amount: 80 }],
          },
        };
      },
    };

    const result = await generateRoutes(provider, baseInput);

    assert.deepEqual(result.outAndBacks, [], "relaxing the shape does not relax road safety");
    assert.ok(result.unsafeRejectedCount > 0);
  });

  it("falls back for a runner whose only road is a dead end", async () => {
    // One straight road out of the house and back again: the familiar graph
    // contains no cycle, so no loop can be proposed from this runner's ground.
    const deadEndRoad = straightTrack(HOME, 90, 2_600, 20);
    const history = [...deadEndRoad, ...deadEndRoad.slice(0, -1).reverse()];
    const provider = providerReturning(OUT_AND_BACK);

    const result = await generateRoutes(provider, {
      ...baseInput,
      familiarityMode: "familiar",
      routeCollections: [history],
    });

    assert.deepEqual(result.routes, [], "there is no loop to be had here");
    assert.ok(result.outAndBacks.length > 0, "so the road he has is the answer");

    const [fallback] = result.outAndBacks;
    assert.equal(fallback.isOutAndBack, true);
    assert.equal(fallback.routedByProvider, true, "still drawn by the router, not by us");
    assert.ok(maxPointGapMeters(fallback.geometry) < 40);
    assert.ok(provider.calls.length > 0);

    // And it is genuinely his road, which is what he asked for.
    assert.ok(
      fallback.familiarityMeasured && fallback.familiarityRatio > 0.8,
      `expected his own ground, got ${(fallback.familiarityRatio * 100).toFixed(0)}%`,
    );
  });

  it("offers nothing when the runner's only road is a dead end and no route comes back", async () => {
    // A single straight road out of the house and back: the familiar graph has
    // no cycle at all, so nothing can be proposed from the runner's history.
    const deadEnd = straightTrack(HOME, 45, 3_000, 20);
    const dead: RouteProvider = { async route() { return null; } };

    const result = await generateRoutes(dead, {
      ...baseInput,
      familiarityMode: "familiar",
      routeCollections: [[...deadEnd, ...deadEnd.slice(0, -1).reverse()]],
    });

    assert.deepEqual(result.routes, []);
    assert.deepEqual(result.outAndBacks, [], "an unrouted line is never offered, at any tier");
    assert.ok(result.rejectedCount > 0);
  });
});

describe("the tier order itself", () => {
  it("puts every loop tier above the out-and-back", () => {
    const ids = SUGGESTION_TIERS.map((tier) => tier.id);
    const outAndBackIndex = ids.indexOf("out-and-back");

    assert.equal(outAndBackIndex, ids.length - 1, "the there-and-back is the last resort, always");
    for (const tier of SUGGESTION_TIERS.slice(0, outAndBackIndex)) {
      assert.equal(tier.isOutAndBack, false, `${tier.id} must be a real loop`);
    }
  });

  it("reads top to bottom, taking the first tier with anything in it", () => {
    assert.equal(pickByTier<string>({ "out-and-back": "b", "loop-round-trip": "a" })?.candidate, "a");
    assert.equal(pickByTier<string>({ "out-and-back": "b" })?.tier.id, "out-and-back");
    assert.equal(pickByTier<string>({}), null);
  });

  it("explains itself only when the runner is not getting what they asked for", () => {
    const context = { targetMeters: TARGET_METERS, distanceMeters: TARGET_METERS };
    const describedBy = (id: string) => SUGGESTION_TIERS.find((tier) => tier.id === id)!.describe(context);

    assert.equal(describedBy("loop-familiarity-matched"), null);
    assert.match(String(describedBy("out-and-back")), /out-and-back/i);
    assert.match(String(describedBy("loop-off-distance")), /closest real loop/i);
  });
});
