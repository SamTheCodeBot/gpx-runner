import { LatLng } from "../types";
import {
  canonicalPointKey,
  haversineMeters,
  polylineDistanceMeters,
  sampleAlongPolyline,
  simplifyByDistance,
} from "./utils/geo";

/** Waypoints closer together than this snap to the same spot and buy nothing. */
const MIN_WAYPOINT_SPACING_METERS = 25;

export type FamiliarEdge = {
  distanceMeters: number;
  /** Oriented from the owning node towards the neighbour, both endpoints included. */
  geometry: LatLng[];
};

export type FamiliarNode = {
  id: string;
  point: LatLng;
  neighbors: Map<string, FamiliarEdge>;
};

export type FamiliarGraph = {
  nodes: Map<string, FamiliarNode>;
  startNodeId: string | null;
};

/**
 * A closed loop the search found on the runner's own ground.
 *
 * This is a **proposal, not a runnable route**. `path` is assembled from the
 * runner's GPS traces quantised onto an ~11 m key, so two ways that merely pass
 * close by collapse onto one node and the path can cut a corner that does not
 * exist on the ground; the last leg is stitched straight back to the start
 * across whatever happens to be there — a house, a river, the harbour.
 *
 * Only `waypoints` leaves this module for real use: feed them to the routing
 * provider and run what it returns. See `searchGraphLoops`.
 */
export type GraphLoop = {
  /** The graph's idea of the loop. Diagnostics and waypoint extraction only. */
  path: LatLng[];
  /** Distance along `path`. An estimate; the provider's number supersedes it. */
  pathDistanceMeters: number;
  /** Straight-line metres stitched on to close the loop back onto the start. */
  closureStitchMeters: number;
  /**
   * Evenly spaced points taken from the runner's own logged ground, ordered
   * around the loop. The start is not included — the caller brackets these with
   * it when asking the provider for a route.
   */
  waypoints: LatLng[];
};

export type GraphLoopSearchOptions = {
  maxResults?: number;
  /** Hard wall-clock budget. The search always returns, with whatever it has. */
  budgetMs?: number;
  /** Hard cap on node expansions, whichever bites first. */
  maxExpansions?: number;
  /** How close to the start a path has to come to count as closed. */
  closureRadiusMeters?: number;
  /** How many intermediate waypoints each loop is reduced to for routing. */
  waypointCount?: number;
  /** Seed for the restart jitter, so runs are reproducible. */
  seed?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
};

export type GraphLoopSearchStats = {
  /** Nodes in the compacted graph the search actually ran on. */
  searchNodes: number;
  /** Nodes in the raw graph before dead ends and degree-2 chains were removed. */
  rawNodes: number;
  expansions: number;
  attempts: number;
  elapsedMs: number;
  loopsFound: number;
  maxDepth: number;
  stoppedBy: "exhausted" | "budget" | "expansions" | "results" | "no-start";
};

export const DEFAULT_GRAPH_LOOP_BUDGET_MS = 2_500;
export const DEFAULT_GRAPH_LOOP_MAX_EXPANSIONS = 50_000;
export const DEFAULT_CLOSURE_RADIUS_METERS = 60;

/** Shortest path, in graph edges, that can count as a loop rather than a there-and-back. */
const MIN_LOOP_EDGES = 3;
/** How many of the most promising neighbours a node is allowed to branch into. */
const BRANCH_LIMIT = 4;
/** Expansions per restart. Small enough that a bad first guess cannot eat the budget. */
const EXPANSIONS_PER_ATTEMPT = 1_500;
/** Restarts that finished without finding anything new before we call it done. */
const BARREN_ATTEMPT_LIMIT = 12;
const MAX_ATTEMPTS = 400;
/** Check the clock every N expansions — must be a power of two. */
const CLOCK_CHECK_MASK = 127;

export function buildFamiliarGraph(trackCollections: LatLng[][], requestedStart: LatLng): FamiliarGraph {
  const nodes = new Map<string, FamiliarNode>();
  let startNodeId: string | null = null;
  let startBestDistance = Number.POSITIVE_INFINITY;

  for (const originalTrack of trackCollections) {
    const track = simplifyByDistance(originalTrack, 18);
    for (let i = 1; i < track.length; i += 1) {
      const a = track[i - 1];
      const b = track[i];
      const distanceMeters = haversineMeters(a, b);
      if (distanceMeters < 8) continue;

      const aKey = canonicalPointKey(a, 4);
      const bKey = canonicalPointKey(b, 4);
      if (aKey === bKey) continue;

      if (!nodes.has(aKey)) nodes.set(aKey, { id: aKey, point: a, neighbors: new Map() });
      if (!nodes.has(bKey)) nodes.set(bKey, { id: bKey, point: b, neighbors: new Map() });

      const nodeA = nodes.get(aKey)!;
      const nodeB = nodes.get(bKey)!;
      const existingAB = nodeA.neighbors.get(bKey);
      if (!existingAB || existingAB.distanceMeters > distanceMeters) {
        nodeA.neighbors.set(bKey, { distanceMeters, geometry: [a, b] });
        nodeB.neighbors.set(aKey, { distanceMeters, geometry: [b, a] });
      }

      const aStartDistance = haversineMeters(requestedStart, a);
      const bStartDistance = haversineMeters(requestedStart, b);
      if (aStartDistance < startBestDistance) {
        startBestDistance = aStartDistance;
        startNodeId = aKey;
      }
      if (bStartDistance < startBestDistance) {
        startBestDistance = bStartDistance;
        startNodeId = bKey;
      }
    }
  }

  if (startBestDistance > 60) {
    startNodeId = null;
  }

  return { nodes, startNodeId };
}

/**
 * Loops on the runner's own ground, found under a hard time and work budget.
 *
 * The search is a greedy, randomly restarted, backtracking DFS:
 *
 *  - it runs on a *compacted* copy of the graph — dead ends dropped, chains of
 *    degree-2 points contracted into single edges that still carry their full
 *    geometry. A 5 km loop over 20 m GPS samples needs ~250 hops on the raw
 *    graph and ~50 on the compacted one;
 *  - a path is closed when it comes within `closureRadiusMeters` of the start,
 *    not when it lands on one exact node. Real loops essentially never return
 *    to the precise node they left from, which is why the old exact-match
 *    search found nothing and therefore never stopped;
 *  - branches that cannot get home inside `targetMeters + tolerance` are pruned
 *    on the straight-line distance back to the start. This is admissible: the
 *    way back is never shorter than the crow flies;
 *  - neighbours are ranked against the distance-from-start profile of a perfect
 *    circular loop, which both guides the search to a closure quickly and
 *    favours the round shapes the scorer wants;
 *  - state is mutated and undone on backtrack instead of copied, so pushing a
 *    step is O(1) rather than O(depth).
 *
 * It always terminates, and always returns the best of whatever it found.
 *
 * What it does **not** do is produce a runnable route. The loops it returns are
 * waypoint proposals; the routing provider turns them into geometry that
 * follows actual ways. See `GraphLoop`.
 */
export function searchGraphLoops(
  graph: FamiliarGraph,
  targetMeters: number,
  toleranceMeters: number,
  options: GraphLoopSearchOptions = {},
): { loops: GraphLoop[]; stats: GraphLoopSearchStats } {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const maxResults = Math.max(1, Math.round(options.maxResults ?? 18));
  const budgetMs = Math.max(1, options.budgetMs ?? DEFAULT_GRAPH_LOOP_BUDGET_MS);
  const maxExpansions = Math.max(1, Math.round(options.maxExpansions ?? DEFAULT_GRAPH_LOOP_MAX_EXPANSIONS));
  const closureRadiusMeters = Math.max(1, options.closureRadiusMeters ?? DEFAULT_CLOSURE_RADIUS_METERS);
  const waypointCount = Math.max(3, Math.round(options.waypointCount ?? 6));
  const deadline = startedAt + budgetMs;
  const rawNodes = graph.nodes.size;

  const nothing = (
    stoppedBy: GraphLoopSearchStats["stoppedBy"],
    searchNodes = 0,
  ): { loops: GraphLoop[]; stats: GraphLoopSearchStats } => ({
    loops: [],
    stats: {
      searchNodes,
      rawNodes,
      expansions: 0,
      attempts: 0,
      elapsedMs: now() - startedAt,
      loopsFound: 0,
      maxDepth: 0,
      stoppedBy,
    },
  });

  if (!graph.startNodeId || rawNodes === 0) return nothing("no-start");
  const rawStart = graph.nodes.get(graph.startNodeId);
  if (!rawStart) return nothing("no-start");

  const startPoint = rawStart.point;
  const searchGraph = compactGraph(graph, closureRadiusMeters);
  const startNode = searchGraph.nodes.get(graph.startNodeId);

  // A start with fewer than two ways out cannot sit on any loop.
  if (!startNode || startNode.neighbors.size < 2) return nothing("no-start", searchGraph.nodes.size);

  const maxDistance = targetMeters + toleranceMeters;
  const minDistance = Math.max(600, targetMeters - toleranceMeters);
  const maxDepth = depthLimitFor(searchGraph, maxDistance);
  const loopRadius = targetMeters / (2 * Math.PI);
  /**
   * Where a perfect circular loop of `targetMeters` would be, relative to its
   * start, after a given fraction of its length: 0 → 2R → 0.
   */
  const desiredOffset = (progress: number) =>
    2 * loopRadius * Math.sin(Math.PI * Math.min(1, Math.max(0, progress)));

  const usedEdges = new Set<string>();
  const visits = new Map<string, number>();
  const edgeStack: FamiliarEdge[] = [];
  const found = new Map<string, GraphLoop>();
  const resultCap = maxResults * 3;

  const random = mulberry32(options.seed ?? 0x5eed);
  let distance = 0;
  let expansions = 0;
  let attempts = 0;
  let attemptExpansions = 0;
  let attemptBudget = EXPANSIONS_PER_ATTEMPT;
  let jitterMeters = 0;
  let deepest = 0;
  let stop = false;
  let stoppedBy: GraphLoopSearchStats["stoppedBy"] = "exhausted";

  /** Closes the current path back onto the start and keeps it if it measures up. */
  const record = (closureStitchMeters: number): boolean => {
    const distanceMeters = distance + closureStitchMeters;
    if (distanceMeters < minDistance || distanceMeters > maxDistance) return false;

    // Two paths over the same edges are the same loop, whichever way round.
    const key = Array.from(usedEdges).sort().join("~");
    if (found.has(key)) return true;

    const path: LatLng[] = [startNode.point];
    for (const edge of edgeStack) {
      for (let i = 1; i < edge.geometry.length; i += 1) path.push(edge.geometry[i]);
    }
    if (closureStitchMeters > 1) path.push(startPoint);

    found.set(key, {
      path,
      pathDistanceMeters: distanceMeters,
      closureStitchMeters,
      waypoints: waypointsAlong(path, waypointCount),
    });
    return true;
  };

  const visit = (nodeId: string, depth: number): void => {
    expansions += 1;
    attemptExpansions += 1;
    if (depth > deepest) deepest = depth;

    if ((expansions & CLOCK_CHECK_MASK) === 0 && now() >= deadline) {
      stop = true;
      stoppedBy = "budget";
      return;
    }
    if (expansions >= maxExpansions) {
      stop = true;
      stoppedBy = "expansions";
      return;
    }
    if (attemptExpansions >= attemptBudget) return;

    const node = searchGraph.nodes.get(nodeId);
    if (!node) return;

    const backHome = haversineMeters(node.point, startPoint);
    if (depth >= MIN_LOOP_EDGES && backHome <= closureRadiusMeters) {
      const closed = record(backHome);
      if (found.size >= resultCap) {
        stop = true;
        stoppedBy = "results";
        return;
      }
      // The loop is shut. Wandering on from here would only make a figure eight.
      if (closed) return;
    }

    if (depth >= maxDepth) return;

    const candidates: {
      id: string;
      edge: FamiliarEdge;
      edgeKey: string;
      nextDistance: number;
      cost: number;
    }[] = [];

    for (const [neighborId, edge] of node.neighbors) {
      const edgeKey = canonicalEdgeKey(nodeId, neighborId);
      if (usedEdges.has(edgeKey)) continue;
      if ((visits.get(neighborId) ?? 0) >= 1) continue;

      const nextDistance = distance + edge.distanceMeters;
      if (nextDistance > maxDistance) continue;

      const neighbor = searchGraph.nodes.get(neighborId);
      if (!neighbor) continue;

      // Admissible prune: the run still has to get back, and it can never do
      // that in less than the straight-line distance.
      const neighborHome = haversineMeters(neighbor.point, startPoint);
      if (nextDistance + neighborHome > maxDistance) continue;

      const cost =
        Math.abs(neighborHome - desiredOffset(nextDistance / targetMeters)) + random() * jitterMeters;
      candidates.push({ id: neighborId, edge, edgeKey, nextDistance, cost });
    }

    candidates.sort((a, b) => a.cost - b.cost);

    for (let i = 0; i < candidates.length && i < BRANCH_LIMIT; i += 1) {
      const candidate = candidates[i];
      const previousVisits = visits.get(candidate.id) ?? 0;

      usedEdges.add(candidate.edgeKey);
      visits.set(candidate.id, previousVisits + 1);
      edgeStack.push(candidate.edge);
      distance = candidate.nextDistance;

      visit(candidate.id, depth + 1);

      distance -= candidate.edge.distanceMeters;
      edgeStack.pop();
      visits.set(candidate.id, previousVisits);
      usedEdges.delete(candidate.edgeKey);

      if (stop || attemptExpansions >= attemptBudget) return;
    }
  };

  let barrenAttempts = 0;
  while (!stop && attempts < MAX_ATTEMPTS) {
    const remainingExpansions = maxExpansions - expansions;
    if (remainingExpansions <= 0) {
      stoppedBy = "expansions";
      break;
    }
    if (now() >= deadline) {
      stoppedBy = "budget";
      break;
    }

    attempts += 1;
    attemptExpansions = 0;
    attemptBudget = Math.min(EXPANSIONS_PER_ATTEMPT, remainingExpansions);
    // The first pass is pure greedy — the circular profile alone, no noise.
    // Later passes widen the jitter to shake the search into other streets.
    jitterMeters = attempts === 1 ? 0 : Math.min(loopRadius, 20 * Math.pow(1.5, attempts - 1));

    const before = found.size;
    visit(startNode.id, 0);
    const completed = attemptExpansions < attemptBudget;

    if (found.size > before) barrenAttempts = 0;
    else if (completed) barrenAttempts += 1;

    if (found.size >= resultCap) {
      stoppedBy = "results";
      break;
    }
    if (barrenAttempts >= BARREN_ATTEMPT_LIMIT) {
      stoppedBy = "exhausted";
      break;
    }
  }

  // Closeness to the requested distance first, but a loop stitched shut over
  // 60 m of who-knows-what is a worse proposal than one that nearly meets
  // itself, so pay for the stitch.
  const loopCost = (loop: GraphLoop) =>
    Math.abs(loop.pathDistanceMeters - targetMeters) + loop.closureStitchMeters * 2;
  const loops = Array.from(found.values())
    .sort((a, b) => loopCost(a) - loopCost(b))
    .slice(0, maxResults);

  return {
    loops,
    stats: {
      searchNodes: searchGraph.nodes.size,
      rawNodes,
      expansions,
      attempts,
      elapsedMs: now() - startedAt,
      loopsFound: loops.length,
      maxDepth,
      stoppedBy,
    },
  };
}

/**
 * The raw graph paths only. Diagnostics and tests — callers that need something
 * a runner can follow want `searchGraphLoops(...).loops[].waypoints` routed
 * through a provider.
 */
export function findGraphLoops(
  graph: FamiliarGraph,
  targetMeters: number,
  toleranceMeters: number,
  maxResults = 18,
  options: GraphLoopSearchOptions = {},
): LatLng[][] {
  return searchGraphLoops(graph, targetMeters, toleranceMeters, { ...options, maxResults }).loops.map(
    (loop) => loop.path,
  );
}

/**
 * Reduces a loop to `count` points spaced evenly by distance along it. The
 * start is deliberately left out: the caller brackets the waypoints with the
 * runner's actual start when asking the provider for a route.
 */
export function waypointsAlong(path: LatLng[], count: number): LatLng[] {
  if (path.length < 3 || count < 1) return [];

  const waypoints: LatLng[] = [];
  for (const point of sampleAlongPolyline(path, count)) {
    const previous = waypoints[waypoints.length - 1];
    if (previous && haversineMeters(previous, point) < MIN_WAYPOINT_SPACING_METERS) continue;
    waypoints.push(point);
  }

  return waypoints;
}

/**
 * A copy of the graph with everything that cannot be part of a loop removed and
 * every uninteresting run of points folded into one edge. Nodes near the start
 * are left alone, because they are the ones a loop closes on.
 */
export function compactGraph(graph: FamiliarGraph, closureRadiusMeters: number): FamiliarGraph {
  const nodes = new Map<string, FamiliarNode>();
  for (const [id, node] of graph.nodes) {
    nodes.set(id, { id, point: node.point, neighbors: new Map(node.neighbors) });
  }

  const startId = graph.startNodeId;
  const startPoint = startId ? graph.nodes.get(startId)?.point : undefined;
  if (!startId || !startPoint) return { nodes, startNodeId: startId };

  const dropNode = (id: string) => {
    const node = nodes.get(id);
    if (!node) return;
    for (const neighborId of node.neighbors.keys()) nodes.get(neighborId)?.neighbors.delete(id);
    nodes.delete(id);
  };

  /** A node with one way in and out is on no cycle, so nothing of value is lost. */
  const pruneDeadEnds = () => {
    let queue = Array.from(nodes.keys());
    while (queue.length > 0) {
      const next: string[] = [];
      for (const id of queue) {
        const node = nodes.get(id);
        if (!node || node.neighbors.size > 1) continue;
        for (const neighborId of node.neighbors.keys()) next.push(neighborId);
        dropNode(id);
      }
      queue = next;
    }
  };

  pruneDeadEnds();

  for (let pass = 0; pass < 8; pass += 1) {
    let contracted = 0;

    for (const id of Array.from(nodes.keys())) {
      const node = nodes.get(id);
      if (!node || node.neighbors.size !== 2) continue;
      if (id === startId) continue;
      if (haversineMeters(node.point, startPoint) <= closureRadiusMeters) continue;

      const [[aId, aEdge], [bId, bEdge]] = Array.from(node.neighbors.entries());
      const a = nodes.get(aId);
      const b = nodes.get(bId);
      if (!a || !b || aId === bId) continue;
      // Folding this away when a and b already touch would delete a real block
      // loop. Leave it; a later pass may still get it.
      if (a.neighbors.has(bId)) continue;

      // aEdge runs node → a, so reverse it to get a → node → b.
      const forward = [...aEdge.geometry].reverse();
      for (let i = 1; i < bEdge.geometry.length; i += 1) forward.push(bEdge.geometry[i]);
      const distanceMeters = aEdge.distanceMeters + bEdge.distanceMeters;

      a.neighbors.set(bId, { distanceMeters, geometry: forward });
      b.neighbors.set(aId, { distanceMeters, geometry: [...forward].reverse() });
      dropNode(id);
      contracted += 1;
    }

    if (contracted === 0) break;
  }

  pruneDeadEnds();

  return { nodes, startNodeId: nodes.has(startId) ? startId : null };
}

/**
 * How deep the search may go. Bounded by how many of the graph's shorter edges
 * fit inside the longest allowed loop, so it adapts to the sampling density
 * instead of assuming one. The old fixed 70 made a 5 km loop over 20 m samples
 * unreachable by construction.
 */
function depthLimitFor(graph: FamiliarGraph, maxDistance: number): number {
  const lengths: number[] = [];
  for (const node of graph.nodes.values()) {
    for (const edge of node.neighbors.values()) lengths.push(edge.distanceMeters);
  }
  if (lengths.length === 0) return 24;

  lengths.sort((a, b) => a - b);
  const lowerQuartile = lengths[Math.floor(lengths.length * 0.25)];
  const step = Math.max(12, lowerQuartile);
  return Math.max(24, Math.min(600, Math.ceil(maxDistance / step) + 6));
}

function canonicalEdgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Small deterministic PRNG so restarts differ but a run is reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function routeDistanceOnGraph(points: LatLng[]): number {
  return polylineDistanceMeters(points);
}
