import "./helpers/alias";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildFamiliarityIndex, computeFamiliarityRatio } from "@/engine/familiarity";
import { buildFamiliarGraph, searchGraphLoops } from "@/engine/familiarityGraph";
import { generateRoutes } from "@/engine/generateRoute";
import { boundTracksNearStart, historyRadiusMeters } from "@/engine/trackHistory";
import {
  haversineMeters,
  maxPointGapMeters,
  normalizeLoop,
  polylineDistanceMeters,
  toSegments,
} from "@/engine/utils/geo";
import type { GeneratedRoute, LatLng, RouteProvider, RouteRequest } from "@/types";
import { waypointCountFor } from "@/engine/generateRoute";
import { buildFalkenbergHistory, FALKENBERG_HOME } from "./helpers/denseHistory";
import { circleLoop, radiusForLoopDistance } from "./helpers/geometry";
import { routeAlongGrid } from "./helpers/gridRouter";

/**
 * "Make sure the route is actually following the maps. Earlier versions have
 * just gone over houses, water, whatever."
 *
 * The familiar-graph search works on the runner's own GPS fixes and closes its
 * loops with a straight stitch back to the start — measured at 40–60 m of line
 * across whatever happens to be there. That geometry is a *proposal*. These
 * tests pin down that it never reaches a runner: the graph contributes
 * waypoints, the routing provider draws the line, and everything reported
 * about the route is measured on the line the provider drew.
 */

const TARGET_KM = 5;
const TARGET_METERS = TARGET_KM * 1_000;

const tracks = boundTracksNearStart(buildFalkenbergHistory(), FALKENBERG_HOME, {
  radiusMeters: historyRadiusMeters(TARGET_KM),
});

/**
 * What a router gives back: a dense line that bends with the ways. 400 points
 * around a 5 km loop is a step of ~12.5 m, so any long straight jump in a
 * returned route did not come from here.
 */
const ROUTED_LINE = circleLoop(FALKENBERG_HOME, radiusForLoopDistance(TARGET_METERS), 400);
const ROUTED_METERS = polylineDistanceMeters(ROUTED_LINE);
/** The engine simplifies history at 18 m; a routed line never jumps further. */
const SIMPLIFICATION_METERS = 18;

function recordingProvider(): RouteProvider & { requests: RouteRequest[] } {
  const provider = {
    requests: [] as RouteRequest[],
    async route(input: RouteRequest) {
      provider.requests.push(input);
      return { geometry: ROUTED_LINE, distanceMeters: ROUTED_METERS, elevationGainMeters: 17 };
    },
  };
  return provider;
}

function everyRoute(result: {
  routes: GeneratedRoute[];
  nearMisses: GeneratedRoute[];
  bestEffort: GeneratedRoute[];
}): GeneratedRoute[] {
  return [...result.routes, ...result.nearMisses, ...result.bestEffort];
}

const baseInput = {
  start: FALKENBERG_HOME,
  targetDistanceKm: TARGET_KM,
  familiarityMode: "familiar" as const,
  routeCollections: tracks,
};

describe("every suggestion is drawn by the routing provider", () => {
  it("sends the graph's loops to the provider as waypoints and returns what comes back", async () => {
    const provider = recordingProvider();
    const result = await generateRoutes(provider, baseInput);

    assert.ok(provider.requests.length > 0, "nothing was routed at all");

    const routed = everyRoute(result);
    assert.ok(routed.length > 0, "expected at least one route to come back");

    for (const route of routed) {
      assert.equal(route.routedByProvider, true);
      assert.equal(
        Math.round(route.distanceMeters),
        Math.round(ROUTED_METERS),
        "distance must be the provider's number, not the length of the graph path",
      );
      assert.ok(
        maxPointGapMeters(route.geometry) < SIMPLIFICATION_METERS * 2,
        `a ${maxPointGapMeters(route.geometry).toFixed(1)} m straight jump is not a routed line`,
      );
    }
  });

  it("asks the provider for a round trip through points on the runner's own ground", async () => {
    const provider = recordingProvider();
    await generateRoutes(provider, baseInput);

    const graph = buildFamiliarGraph(tracks, FALKENBERG_HOME);
    const { loops } = searchGraphLoops(graph, TARGET_METERS, 500, { maxResults: 24 });
    assert.ok(loops.length > 0, "fixture must produce graph loops for this test to mean anything");

    const graphRequests = provider.requests.filter((request) =>
      request.coordinates.slice(1, -1).every((waypoint) =>
        tracks.some((track) => track.some((point) => haversineMeters(point, waypoint) < 30)),
      ),
    );
    assert.ok(graphRequests.length > 0, "no request was built from the runner's history");

    for (const request of graphRequests) {
      assert.ok(request.coordinates.length >= 4, "a loop needs a start, waypoints and a start again");
      assert.ok(haversineMeters(request.coordinates[0], FALKENBERG_HOME) < 1, "must start at the start");
      assert.ok(
        haversineMeters(request.coordinates[request.coordinates.length - 1], FALKENBERG_HOME) < 1,
        "must come back to the start",
      );
    }
  });

  it("never hands back the graph's own stitched-together geometry", async () => {
    const graph = buildFamiliarGraph(tracks, FALKENBERG_HOME);
    const { loops } = searchGraphLoops(graph, TARGET_METERS, 500, { maxResults: 24 });

    // The proposals really do contain the straight closing stitch this guards
    // against — otherwise the test proves nothing.
    const stitched = loops.filter((loop) => loop.closureStitchMeters > SIMPLIFICATION_METERS);
    assert.ok(stitched.length > 0, "fixture must produce stitched loops");
    assert.ok(
      maxPointGapMeters(stitched[0].path) > SIMPLIFICATION_METERS * 2,
      "the raw graph path is exactly the geometry that must never be returned",
    );

    const provider = recordingProvider();
    const result = await generateRoutes(provider, baseInput);

    for (const route of everyRoute(result)) {
      for (const loop of loops) {
        assert.notDeepEqual(route.geometry, loop.path);
        assert.notDeepEqual(route.geometry, normalizeLoop(loop.path));
      }
    }
  });

  it("measures familiarity on the routed line, not on the proposal", async () => {
    const provider = recordingProvider();
    const result = await generateRoutes(provider, baseInput);

    const index = buildFamiliarityIndex(tracks);
    const onRoutedLine = computeFamiliarityRatio(toSegments(normalizeLoop(ROUTED_LINE)), index);

    const routed = everyRoute(result);
    assert.ok(routed.length > 0);
    for (const route of routed) {
      assert.ok(
        Math.abs(route.familiarityRatio - onRoutedLine) < 0.01,
        `reported ${(route.familiarityRatio * 100).toFixed(1)}%, routed line is ${(onRoutedLine * 100).toFixed(1)}%`,
      );
    }

    // The proposals were 100% familiar by construction. Reporting that number
    // for a line the runner will not run is the lie this guards against.
    const graph = buildFamiliarGraph(tracks, FALKENBERG_HOME);
    const { loops } = searchGraphLoops(graph, TARGET_METERS, 500, { maxResults: 6 });
    const onProposal = computeFamiliarityRatio(toSegments(normalizeLoop(loops[0].path)), index);
    assert.ok(onProposal > 0.95, "the proposal is on known ground");
    assert.ok(
      Math.abs(onProposal - onRoutedLine) > 0.05,
      "fixture must make the two measurements differ, or this asserts nothing",
    );
  });

  it("returns nothing at all rather than something unrouted when the provider is down", async () => {
    const dead: RouteProvider = { async route() { return null; } };
    const result = await generateRoutes(dead, baseInput);

    assert.deepEqual(result.routes, []);
    assert.deepEqual(result.nearMisses, []);
    assert.deepEqual(result.bestEffort, []);
    assert.ok(result.rejectedCount > 0);
  });
});

describe("waypoint density", () => {
  /**
   * The provider takes the shortest way between consecutive waypoints, so
   * every waypoint left out is licence to cut a corner. Too few and the
   * runner is sold a "5 km" route that is under 3 km once it has been routed.
   * Measured against a router that walks the street grid the history was run
   * on, rather than against a stub that returns whatever it is handed.
   */
  it("pins the routed line close to the length of the loop it came from", () => {
    const graph = buildFamiliarGraph(tracks, FALKENBERG_HOME);

    const lengthWith = (waypointCount: number) => {
      const { loops } = searchGraphLoops(graph, TARGET_METERS, 500, { maxResults: 6, waypointCount });
      const ratios = loops.map((loop) => {
        const routed = routeAlongGrid([FALKENBERG_HOME, ...loop.waypoints, FALKENBERG_HOME]);
        return polylineDistanceMeters(routed) / loop.pathDistanceMeters;
      });
      return ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
    };

    const sparse = lengthWith(6);
    const shipped = lengthWith(waypointCountFor(TARGET_METERS));

    assert.ok(sparse < 0.75, `6 waypoints should let the router shortcut badly, kept ${(sparse * 100).toFixed(0)}%`);
    assert.ok(
      shipped > sparse + 0.1,
      `the shipped density must hold the line far better: ${(shipped * 100).toFixed(0)}% vs ${(sparse * 100).toFixed(0)}%`,
    );
  });

  it("stays inside openrouteservice's 50-waypoint limit for a directions call", () => {
    for (const km of [1, 5, 10, 42, 100]) {
      const count = waypointCountFor(km * 1_000);
      assert.ok(count >= 6, `${km} km got only ${count} waypoints`);
      // The start brackets them at both ends.
      assert.ok(count + 2 <= 50, `${km} km would send ${count + 2} coordinates`);
    }
  });
});

describe("the request deadline", () => {
  it("stops instead of running past it, and says so", async () => {
    const provider = recordingProvider();
    const result = await generateRoutes(provider, { ...baseInput, deadlineAt: Date.now() - 1 });

    assert.equal(result.timedOut, true);
    assert.equal(provider.requests.length, 0, "no provider call may start after the deadline");
  });

  it("returns within its budget on the dense history", async () => {
    const provider = recordingProvider();
    const startedAt = Date.now();
    await generateRoutes(provider, { ...baseInput, deadlineAt: Date.now() + 5_000 });

    assert.ok(Date.now() - startedAt < 5_000, "generation overran its own deadline");
  });
});
