import { LatLng } from "../types";
import {
  canonicalPointKey,
  haversineMeters,
  polylineDistanceMeters,
  simplifyByDistance,
} from "./utils/geo";

export type FamiliarNode = {
  id: string;
  point: LatLng;
  neighbors: Map<string, { distanceMeters: number; geometry: LatLng[] }>;
};

export type FamiliarGraph = {
  nodes: Map<string, FamiliarNode>;
  startNodeId: string | null;
};

type SearchState = {
  nodeId: string;
  pathNodeIds: string[];
  geometry: LatLng[];
  distanceMeters: number;
  usedEdges: Set<string>;
  visitedNodes: Set<string>;
};

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

export function findGraphLoops(
  graph: FamiliarGraph,
  targetMeters: number,
  toleranceMeters: number,
  maxResults = 18,
): LatLng[][] {
  if (!graph.startNodeId || graph.nodes.size === 0) return [];

  const startNode = graph.nodes.get(graph.startNodeId);
  if (!startNode) return [];

  const results: { geometry: LatLng[]; distanceMeters: number }[] = [];
  const stack: SearchState[] = [
    {
      nodeId: startNode.id,
      pathNodeIds: [startNode.id],
      geometry: [startNode.point],
      distanceMeters: 0,
      usedEdges: new Set<string>(),
      visitedNodes: new Set([startNode.id]),
    },
  ];

  const maxDistance = targetMeters + toleranceMeters;
  const minDistance = Math.max(600, targetMeters - toleranceMeters);
  const maxDepth = Math.min(70, Math.max(10, Math.round(targetMeters / 70)));

  while (stack.length > 0 && results.length < maxResults * 6) {
    const state = stack.pop()!;
    const node = graph.nodes.get(state.nodeId);
    if (!node) continue;

    if (state.pathNodeIds.length > maxDepth) continue;

    const nextStates: SearchState[] = [];

    for (const [neighborId, edge] of node.neighbors.entries()) {
      const edgeKey = canonicalEdgeKey(node.id, neighborId);
      const newDistance = state.distanceMeters + edge.distanceMeters;
      if (newDistance > maxDistance) continue;
      if (state.usedEdges.has(edgeKey)) continue;

      const isClosing = neighborId === graph.startNodeId && state.pathNodeIds.length >= 4;
      const revisitCount = state.pathNodeIds.filter((id) => id === neighborId).length;
      if (!isClosing && revisitCount >= 1) continue;

      const neighbor = graph.nodes.get(neighborId);
      if (!neighbor) continue;

      const nextGeometry = [...state.geometry, neighbor.point];
      if (isClosing) {
        if (newDistance >= minDistance) {
          results.push({ geometry: nextGeometry, distanceMeters: newDistance });
        }
        continue;
      }

      nextStates.push({
        nodeId: neighborId,
        pathNodeIds: [...state.pathNodeIds, neighborId],
        geometry: nextGeometry,
        distanceMeters: newDistance,
        usedEdges: new Set([...state.usedEdges, edgeKey]),
        visitedNodes: new Set([...state.visitedNodes, neighborId]),
      });
    }

    nextStates.sort((a, b) => {
      const aBias = Math.abs(targetMeters - a.distanceMeters) + 35 * a.pathNodeIds.length;
      const bBias = Math.abs(targetMeters - b.distanceMeters) + 35 * b.pathNodeIds.length;
      return bBias - aBias;
    });

    for (const next of nextStates.slice(0, 4)) {
      stack.push(next);
    }
  }

  const deduped = new Map<string, { geometry: LatLng[]; distanceMeters: number }>();
  for (const result of results) {
    const key = result.geometry.map((p) => canonicalPointKey(p, 4)).join("|");
    const existing = deduped.get(key);
    if (!existing || Math.abs(existing.distanceMeters - targetMeters) > Math.abs(result.distanceMeters - targetMeters)) {
      deduped.set(key, result);
    }
  }

  return Array.from(deduped.values())
    .sort((a, b) => Math.abs(a.distanceMeters - targetMeters) - Math.abs(b.distanceMeters - targetMeters))
    .slice(0, maxResults)
    .map((entry) => entry.geometry);
}

function canonicalEdgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function routeDistanceOnGraph(points: LatLng[]): number {
  return polylineDistanceMeters(points);
}
