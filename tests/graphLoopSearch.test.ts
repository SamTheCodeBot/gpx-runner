import "./helpers/alias";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildFamiliarityIndex, computeFamiliarityRatio } from "@/engine/familiarity";
import { buildFamiliarGraph, compactGraph, searchGraphLoops } from "@/engine/familiarityGraph";
import { boundTracksNearStart, historyRadiusMeters } from "@/engine/trackHistory";
import { haversineMeters, normalizeLoop, toSegments } from "@/engine/utils/geo";
import { buildFalkenbergHistory, FALKENBERG_HOME, FALKENBERG_RUNS } from "./helpers/denseHistory";

/**
 * The search that used to hang.
 *
 * A sparse synthetic fixture never showed the bug. This is the real shape of
 * the problem: 75 logged runs, ~585 km, every one of them starting from the
 * same house and reusing the same street grid. That reuse is the point — it is
 * what makes the familiar graph dense, and density is what the old exact-match
 * DFS could not survive. It was killed at 45 s without ever returning.
 *
 * The bar here is deliberately two-sided. Terminating is not the requirement;
 * terminating *with loops* is. A search that gave up instantly and returned
 * nothing would pass a timing assertion and be useless.
 */

const TARGET_METERS = 5_000;
const TOLERANCE_METERS = 500;
/** Comfortably under the request budget, and ~100× what it actually takes. */
const TIME_LIMIT_MS = 3_000;

const bounded = boundTracksNearStart(buildFalkenbergHistory(), FALKENBERG_HOME, {
  radiusMeters: historyRadiusMeters(TARGET_METERS / 1000),
});
const graph = buildFamiliarGraph(bounded, FALKENBERG_HOME);

describe("searchGraphLoops on a dense real-world history", () => {
  it("builds the dense graph that used to be unsearchable", () => {
    assert.equal(bounded.length, FALKENBERG_RUNS);
    assert.ok(graph.nodes.size > 2_000, `expected a dense graph, got ${graph.nodes.size} nodes`);
    assert.ok(graph.startNodeId, "every run starts at the house, so the start must be on the graph");

    // Dead ends dropped and degree-2 chains contracted. Without this the search
    // needs ~250 hops to walk a 5 km loop over 20 m GPS samples.
    const compacted = compactGraph(graph, 60);
    assert.ok(
      compacted.nodes.size < graph.nodes.size / 2,
      `compaction must cut the search space, ${graph.nodes.size} -> ${compacted.nodes.size}`,
    );
  });

  it("returns loops in well under three seconds, and returns some", () => {
    const startedAt = Date.now();
    const { loops, stats } = searchGraphLoops(graph, TARGET_METERS, TOLERANCE_METERS, { maxResults: 24 });
    const elapsedMs = Date.now() - startedAt;

    assert.ok(elapsedMs < TIME_LIMIT_MS, `took ${elapsedMs} ms on ${stats.rawNodes} raw nodes`);
    assert.ok(loops.length > 0, "terminating empty-handed is not a fix — the search must find loops");
    assert.equal(stats.rawNodes, graph.nodes.size);
    assert.ok(stats.searchNodes < stats.rawNodes, "the search must run on the compacted graph");
  });

  it("proposes loops of the requested length, on ground the runner knows", () => {
    const { loops } = searchGraphLoops(graph, TARGET_METERS, TOLERANCE_METERS, { maxResults: 24 });
    const index = buildFamiliarityIndex(bounded);

    for (const loop of loops) {
      assert.ok(
        Math.abs(loop.pathDistanceMeters - TARGET_METERS) <= TOLERANCE_METERS,
        `loop of ${loop.pathDistanceMeters.toFixed(0)} m is outside the tolerance`,
      );

      // Every metre of it is ground this runner has already covered — that is
      // the whole point of searching their own history rather than the map.
      const ratio = computeFamiliarityRatio(toSegments(normalizeLoop(loop.path)), index);
      assert.ok(ratio > 0.95, `expected a loop on known ground, got ${(ratio * 100).toFixed(1)}% familiar`);

      // A real loop that goes somewhere, not a thin out-and-back along one street.
      const maxRadius = Math.max(...loop.path.map((point) => haversineMeters(point, FALKENBERG_HOME)));
      assert.ok(maxRadius > 300, `loop never gets further than ${maxRadius.toFixed(0)} m from the start`);
    }
  });

  it("reduces every loop to waypoints taken off the runner's own ground", () => {
    const { loops } = searchGraphLoops(graph, TARGET_METERS, TOLERANCE_METERS, {
      maxResults: 8,
      waypointCount: 6,
    });

    assert.ok(loops.length > 0);
    for (const loop of loops) {
      assert.ok(loop.waypoints.length >= 2, "a loop needs enough waypoints to hold its shape");
      assert.ok(loop.waypoints.length <= 6);

      for (const waypoint of loop.waypoints) {
        // The start brackets the waypoints; it is never one of them.
        assert.ok(
          haversineMeters(waypoint, FALKENBERG_HOME) > 25,
          "a waypoint on the start would close the loop early",
        );
        assert.ok(
          loop.path.some((point) => haversineMeters(point, waypoint) < 1),
          "every waypoint must be a point of the proposed loop",
        );
      }
    }
  });

  it("always comes back, whatever budget it is given", () => {
    for (const budgetMs of [1, 25, 250]) {
      const startedAt = Date.now();
      const { stats } = searchGraphLoops(graph, TARGET_METERS, TOLERANCE_METERS, { budgetMs });
      const elapsedMs = Date.now() - startedAt;

      assert.ok(elapsedMs < TIME_LIMIT_MS, `budget ${budgetMs} ms took ${elapsedMs} ms`);
      assert.ok(
        ["budget", "results", "exhausted", "expansions"].includes(stats.stoppedBy),
        `unexpected stop reason ${stats.stoppedBy}`,
      );
    }
  });

  it("is reproducible", () => {
    const first = searchGraphLoops(graph, TARGET_METERS, TOLERANCE_METERS, { maxResults: 6 });
    const second = searchGraphLoops(graph, TARGET_METERS, TOLERANCE_METERS, { maxResults: 6 });

    assert.deepEqual(
      first.loops.map((loop) => Math.round(loop.pathDistanceMeters)),
      second.loops.map((loop) => Math.round(loop.pathDistanceMeters)),
    );
  });
});
