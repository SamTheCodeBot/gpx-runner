import "./helpers/alias";
import { buildFamiliarGraph, searchGraphLoops, compactGraph } from "@/engine/familiarityGraph";
import { buildFamiliarityIndex, computeFamiliarityRatio } from "@/engine/familiarity";
import { boundTracksNearStart, historyRadiusMeters } from "@/engine/trackHistory";
import { polylineDistanceMeters, toSegments, normalizeLoop, haversineMeters } from "@/engine/utils/geo";
import { buildFalkenbergHistory, FALKENBERG_HOME } from "./helpers/denseHistory";

const tracks = buildFalkenbergHistory();
const bounded = boundTracksNearStart(tracks, FALKENBERG_HOME, { radiusMeters: historyRadiusMeters(5) });
const graph = buildFamiliarGraph(bounded, FALKENBERG_HOME);
const compact = compactGraph(graph, 60);
console.log(`raw nodes ${graph.nodes.size} -> compacted ${compact.nodes.size}`);
const t0 = Date.now();
const { loops, stats } = searchGraphLoops(graph, 5000, 500, { maxResults: 24 });
console.log(`elapsed ${Date.now() - t0} ms`, stats);
const index = buildFamiliarityIndex(bounded);
for (const loop of loops.slice(0, 6)) {
  const geom = normalizeLoop(loop.geometry);
  const ratio = computeFamiliarityRatio(toSegments(geom), index);
  const maxR = Math.max(...geom.map((p) => haversineMeters(p, FALKENBERG_HOME)));
  console.log(
    `  dist=${loop.distanceMeters.toFixed(0)}m polyline=${polylineDistanceMeters(geom).toFixed(0)}m ` +
    `pts=${geom.length} stitch=${loop.closureStitchMeters.toFixed(1)}m familiar=${(ratio * 100).toFixed(1)}% maxRadius=${maxR.toFixed(0)}m`,
  );
}
