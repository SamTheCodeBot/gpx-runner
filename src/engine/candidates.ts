import { FamiliarityMode, LatLng } from "../types";
import { familiarityRangeForMode } from "./config";
import { estimatePathKnownness, knownnessAt, type FamiliarityIndex } from "./familiarity";
import { haversineMeters, destinationPoint, simplifyByDistance } from "./utils/geo";

export type CandidateWaypoints = {
  seed: string;
  waypoints: LatLng[];
  /**
   * How much of this proposal is ground the runner already knows, predicted
   * from his history before any provider is paid to draw it. `null` when there
   * is no history to predict from.
   */
  predictedKnownness?: number | null;
};

type ShapePoint = { angle: number; scale: number };
type ShapeTemplate = {
  name: string;
  points: ShapePoint[];
};

const SHAPES: ShapeTemplate[] = [
  {
    name: "square-even",
    points: [
      { angle: 0, scale: 1 },
      { angle: 90, scale: 1.02 },
      { angle: 180, scale: 0.98 },
      { angle: 270, scale: 1.0 },
    ],
  },
  {
    name: "square-tilted",
    points: [
      { angle: 35, scale: 1.02 },
      { angle: 125, scale: 0.98 },
      { angle: 215, scale: 1.02 },
      { angle: 305, scale: 0.98 },
    ],
  },
  {
    name: "pentagon-even",
    points: [
      { angle: 0, scale: 1 },
      { angle: 72, scale: 1.01 },
      { angle: 144, scale: 0.99 },
      { angle: 216, scale: 1.01 },
      { angle: 288, scale: 0.99 },
    ],
  },
  {
    name: "pentagon-soft",
    points: [
      { angle: 18, scale: 1.03 },
      { angle: 88, scale: 0.97 },
      { angle: 162, scale: 1.0 },
      { angle: 234, scale: 0.98 },
      { angle: 306, scale: 1.02 },
    ],
  },
  {
    name: "hexagon-even",
    points: [
      { angle: 0, scale: 1 },
      { angle: 60, scale: 1.0 },
      { angle: 120, scale: 0.98 },
      { angle: 180, scale: 1.01 },
      { angle: 240, scale: 0.99 },
      { angle: 300, scale: 1.0 },
    ],
  },
];

/**
 * How long the route through a shape actually is, per unit radius.
 *
 * Not the perimeter of the ring. The provider is asked for
 * `start → p1 → … → pN → start`, and the start sits in the *middle* of the ring,
 * so the leg from pN back to p1 is never run — two spokes of one radius each are
 * run instead. Sizing the ring by its perimeter therefore asks for a route that
 * is systematically too long: for a square, by 0.59 radii, and for a hexagon by
 * a full one. Measured on the Falkenberg fixture, every one of the twenty
 * candidates a "new ground" request generates at 5.5 km came back between
 * 6,094 m and 7,624 m — all of them outside the ±500 m gate, so not one could
 * be returned and the answer came from the round-trip fallback instead, which
 * cannot steer familiarity at all.
 */
function normalizedPathLength(shape: ShapeTemplate): number {
  const points = shape.points.map((point) => ({
    x: Math.cos((point.angle * Math.PI) / 180) * point.scale,
    y: Math.sin((point.angle * Math.PI) / 180) * point.scale,
  }));

  // The two spokes: out to the first waypoint, home from the last.
  let total = Math.hypot(points[0].x, points[0].y) + Math.hypot(points[points.length - 1].x, points[points.length - 1].y);

  for (let i = 0; i < points.length - 1; i += 1) {
    total += Math.hypot(points[i].x - points[i + 1].x, points[i].y - points[i + 1].y);
  }

  return total;
}

/**
 * Lengths to propose, as a fraction of what was asked for.
 *
 * These used to differ by familiarity mode — reach further out when the runner
 * wants new ground — which made sense only while the ring was sized by its
 * perimeter and every proposal was over-long anyway. Now that
 * `normalizedPathLength` sizes it by the route that is actually run, a
 * multiplier *is* the length of the run, and quietly asking for 22% more than
 * the runner typed is not steering familiarity, it is answering a different
 * question. Where the loop goes is chosen by where the loop goes.
 *
 * What is left is a hedge, and it leans short on purpose: a router never
 * returns less than the straight line through the waypoints it was given, so
 * the distance error is one-sided.
 */
const LENGTH_HEDGES = [0.92, 0.96, 1, 1.04];

function bearingFrom(start: LatLng, point: LatLng): number {
  const y = Math.sin(((point.lng - start.lng) * Math.PI) / 180) * Math.cos((point.lat * Math.PI) / 180);
  const x =
    Math.cos((start.lat * Math.PI) / 180) * Math.sin((point.lat * Math.PI) / 180) -
    Math.sin((start.lat * Math.PI) / 180) *
      Math.cos((point.lat * Math.PI) / 180) *
      Math.cos(((point.lng - start.lng) * Math.PI) / 180);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function buildFamiliarSeedCandidates(
  start: LatLng,
  targetDistanceMeters: number,
  trackCollections: LatLng[][],
  limit: number,
): CandidateWaypoints[] {
  const simplifiedPoints = trackCollections.flatMap((track) => simplifyByDistance(track, 30));
  if (simplifiedPoints.length < 20) return [];

  const expectedRadius = Math.max(160, targetDistanceMeters / (2 * Math.PI));
  const minRadius = Math.max(100, expectedRadius * 0.58);
  const maxRadius = expectedRadius * 1.55;

  const candidates = simplifiedPoints
    .map((point) => ({
      point,
      distance: haversineMeters(start, point),
      bearing: bearingFrom(start, point),
    }))
    .filter((entry) => entry.distance >= minRadius && entry.distance <= maxRadius)
    .sort((a, b) => a.distance - b.distance);

  if (candidates.length < 12) return [];

  const bucketed = new Map<number, typeof candidates>();
  for (const entry of candidates) {
    const bucket = Math.floor(entry.bearing / 30);
    const list = bucketed.get(bucket) ?? [];
    list.push(entry);
    bucketed.set(bucket, list);
  }

  const allBuckets = Array.from(bucketed.keys()).sort((a, b) => a - b);
  const results: CandidateWaypoints[] = [];

  const pointFromBucket = (bucket: number, variant = 0) => {
    const list = (bucketed.get(((bucket % 12) + 12) % 12) ?? []).slice().sort((a, b) => b.distance - a.distance);
    return list[Math.min(variant, list.length - 1)]?.point ?? null;
  };

  for (const bucket of allBuckets) {
    const patterns = [
      [bucket, bucket + 2, bucket + 5, bucket + 8],
      [bucket, bucket + 3, bucket + 6, bucket + 9],
      [bucket, bucket + 2, bucket + 4, bucket + 7, bucket + 9],
    ];

    for (const pattern of patterns) {
      for (let variant = 0; variant < 2; variant += 1) {
        const points = pattern
          .map((b) => pointFromBucket(b, variant))
          .filter((point): point is LatLng => point !== null);

        if (points.length < 4) continue;

        const unique = points.filter(
          (point, index) =>
            points.findIndex((other) => haversineMeters(point, other) < 35) === index,
        );

        if (unique.length < 4) continue;

        results.push({
          seed: `familiar-buckets:${pattern.join("-")}:${variant}`,
          waypoints: unique,
        });

        if (results.length >= limit) return results;
      }
    }
  }

  return results;
}

/**
 * Waypoints aimed at ground the runner has *not* covered.
 *
 * The mirror image of `buildFamiliarSeedCandidates`, and until now the missing
 * half of the engine: asking for new ground produced evenly spaced rings around
 * the front door and measured familiarity afterwards, hoping one of them landed
 * low. That is sampling, not searching, and on a dense history it never lands:
 * a ring centred on the door has to cross the well-trodden ground in *every*
 * direction, including the ones the runner uses daily.
 *
 * Two things change here.
 *
 * First the shape. The loop is a polygon inscribed in a circle that is offset
 * from the start by its own radius, so the start is a vertex on the ring rather
 * than its centre. The run therefore leans entirely to one side of the house
 * instead of encircling it, which is the only way most of its length can sit on
 * ground the runner does not already know.
 *
 * Then the aim. `familiarity.ts` already keeps a ~40 m grid of covered ground;
 * read backwards it says where the runner has *never* been. Bearings are ranked
 * by how little known ground lies along them, and each waypoint is nudged in or
 * out to the emptiest spot on its own spoke. No second index, and not one extra
 * provider call: this is all arithmetic against a grid that was built anyway.
 */
function buildUnfamiliarSeedCandidates(
  start: LatLng,
  targetDistanceMeters: number,
  index: FamiliarityIndex,
  limit: number,
): CandidateWaypoints[] {
  if (limit <= 0 || index.familiarSegments.length === 0) return [];

  const vertexCounts = unfamiliarVertexCounts(targetDistanceMeters);
  const bearings = rankBearingsByEmptiness(
    start,
    index,
    offsetLoopRadius(targetDistanceMeters, vertexCounts[0]),
  );

  // ── Where to aim ───────────────────────────────────────────────────────────
  // Judged at the length the runner actually asked for, so a proposal cannot
  // win on emptiness by quietly being a longer run.
  const aims: { bearing: number; vertexCount: number; knownness: number }[] = [];

  for (const vertexCount of vertexCounts) {
    for (const bearing of bearings) {
      const waypoints = offsetLoopWaypoints(
        start,
        bearing,
        offsetLoopRadius(targetDistanceMeters, vertexCount),
        vertexCount,
        targetDistanceMeters,
        index,
      );
      if (waypoints.length < 3) continue;

      aims.push({
        bearing,
        vertexCount,
        knownness: estimatePathKnownness([start, ...waypoints, start], index),
      });
    }
  }

  aims.sort((a, b) => a.knownness - b.knownness);

  // Emptiest first, one aim per direction: a shortlist of six variations on one
  // bearing is one guess, not six.
  const seenBearings = new Set<number>();
  const distinct = aims.filter((aim) => {
    if (seenBearings.has(aim.bearing)) return false;
    seenBearings.add(aim.bearing);
    return true;
  });

  // ── How long to propose it ─────────────────────────────────────────────────
  // Every direction is tried at the requested length before any of them is
  // tried again at another: a second guess at one bearing is worth less than a
  // first guess at a bearing nobody has looked down.
  const chosen: CandidateWaypoints[] = [];

  for (const lengthScale of LENGTH_SCALES) {
    for (const aim of distinct) {
      if (chosen.length >= limit) return chosen;

      const proposedMeters = targetDistanceMeters * lengthScale;
      const waypoints = offsetLoopWaypoints(
        start,
        aim.bearing,
        offsetLoopRadius(proposedMeters, aim.vertexCount),
        aim.vertexCount,
        proposedMeters,
        index,
      );
      if (waypoints.length < 3) continue;

      chosen.push({
        seed: `unfamiliar-offset:${Math.round(aim.bearing)}:${aim.vertexCount}:${lengthScale}`,
        waypoints,
        predictedKnownness: estimatePathKnownness([start, ...waypoints, start], index),
      });
    }
  }

  return chosen;
}

/**
 * Lengths to propose, as a fraction of what was asked for.
 *
 * A router never returns *less* than the straight line between the waypoints it
 * was given, and on real streets it returns a few percent more. So a proposal
 * measured at exactly the target can only miss the ±500 m gate on one side, and
 * sits on its edge before the first call is made. Offering a short one and a
 * long one puts the network's own detour factor — whatever it turns out to be —
 * inside the band rather than at its rim.
 */
const LENGTH_SCALES = [1, 0.95];

/**
 * Two polygon resolutions, because they are two different runs. More vertices
 * pin the router down harder and trace the offset circle more closely; fewer
 * give it room to find its own way round, which on a real street network is
 * sometimes the only way round at all. Waypoints are coordinates in one call,
 * never extra calls, so asking for both costs nothing.
 */
function unfamiliarVertexCounts(targetDistanceMeters: number): number[] {
  const fine = Math.max(8, Math.min(20, Math.round(targetDistanceMeters / 450)));
  const coarse = Math.max(6, Math.round(fine * 0.6));
  return fine === coarse ? [fine] : [fine, coarse];
}

/**
 * The radius that makes the run the requested length.
 *
 * `vertexCount` vertices on a circle of radius r, one of them the start, give a
 * closed path of `2 * n * r * sin(pi / n)`. Solved for r, so the proposal is the
 * right length before the provider ever sees it.
 */
function offsetLoopRadius(targetDistanceMeters: number, vertexCount: number): number {
  return Math.max(150, targetDistanceMeters / (2 * vertexCount * Math.sin(Math.PI / vertexCount)));
}

/**
 * Which way out of the door has the least of the runner's own history along it.
 *
 * Sampled along each ray across the band the loop body will occupy — from half a
 * radius out to the far side of the offset circle — and returned least-known
 * first, keeping the chosen bearings apart so the candidates are genuinely
 * different runs rather than one direction sampled six times.
 */
function rankBearingsByEmptiness(start: LatLng, index: FamiliarityIndex, radiusMeters: number): number[] {
  const inner = radiusMeters * 0.5;
  const outer = radiusMeters * 2;
  const step = Math.max(40, (outer - inner) / 24);

  const scored: { bearing: number; knownness: number }[] = [];

  for (let bearing = 0; bearing < 360; bearing += BEARING_PROBE_STEP) {
    let total = 0;
    let samples = 0;

    for (let distance = inner; distance <= outer; distance += step) {
      total += knownnessAt(destinationPoint(start, bearing, distance), index);
      samples += 1;
    }

    scored.push({ bearing, knownness: samples === 0 ? 1 : total / samples });
  }

  scored.sort((a, b) => a.knownness - b.knownness);

  const chosen: number[] = [];
  for (const entry of scored) {
    const tooClose = chosen.some((bearing) => angularDistance(bearing, entry.bearing) < MIN_SEED_BEARING_SEPARATION);
    if (tooClose) continue;
    chosen.push(entry.bearing);
    if (chosen.length >= UNFAMILIAR_SEED_BEARINGS) break;
  }

  return chosen;
}

/**
 * One offset loop, with every waypoint pulled towards the emptiest ground on
 * its own spoke and the whole ring then rescaled back to the requested length.
 */
function offsetLoopWaypoints(
  start: LatLng,
  bearing: number,
  nominalRadius: number,
  vertexCount: number,
  targetDistanceMeters: number,
  index: FamiliarityIndex,
): LatLng[] {
  const centre = destinationPoint(start, bearing, nominalRadius);
  const startAngle = (bearing + 180) % 360;
  const angularStep = 360 / vertexCount;

  // One angle per waypoint, walking the ring away from the start vertex.
  const angles: number[] = [];
  for (let i = 1; i < vertexCount; i += 1) angles.push((startAngle + i * angularStep) % 360);

  const scales = angles.map((angle) => emptiestRadiusScale(centre, angle, nominalRadius, angularStep, index));

  const build = (radius: number): LatLng[] =>
    angles.map((angle, i) => destinationPoint(centre, angle, radius * scales[i]));

  // Nudging the waypoints changed the length; one rescale puts it back.
  const nudged = build(nominalRadius);
  const length = closedPathLength(start, nudged);
  const corrected = length > 0 ? nominalRadius * (targetDistanceMeters / length) : nominalRadius;

  // The centre moves with the ring, so the start stays on it.
  const correctedCentre = destinationPoint(start, bearing, corrected);
  return angles.map((angle, i) => destinationPoint(correctedCentre, angle, corrected * scales[i]));
}

/** In or out along one spoke, wherever the runner's history thins out most. */
function emptiestRadiusScale(
  centre: LatLng,
  angle: number,
  nominalRadius: number,
  angularStep: number,
  index: FamiliarityIndex,
): number {
  let bestScale = 1;
  let bestKnownness = Number.POSITIVE_INFINITY;

  for (const scale of RADIAL_NUDGES) {
    // Judge the corridor either side of the vertex, not the single point: the
    // provider runs through the waypoint, it does not stop there.
    let knownness = 0;
    for (const offset of [-angularStep / 3, 0, angularStep / 3]) {
      knownness += knownnessAt(destinationPoint(centre, (angle + offset + 360) % 360, nominalRadius * scale), index);
    }

    // Ties go to the round shape: a lumpy ring is a worse run, and the loop
    // shape gate is never relaxed to chase a familiarity number.
    const roundnessTieBreak = Math.abs(scale - 1) * 1e-3;
    if (knownness + roundnessTieBreak < bestKnownness) {
      bestKnownness = knownness + roundnessTieBreak;
      bestScale = scale;
    }
  }

  return bestScale;
}

function closedPathLength(start: LatLng, waypoints: LatLng[]): number {
  let total = 0;
  let previous = start;
  for (const point of waypoints) {
    total += haversineMeters(previous, point);
    previous = point;
  }
  return total + haversineMeters(previous, start);
}

function angularDistance(a: number, b: number): number {
  const delta = Math.abs(a - b) % 360;
  return delta > 180 ? 360 - delta : delta;
}

/**
 * The least-known loop this start could offer at a given length, predicted from
 * the runner's history alone.
 *
 * No provider call, no promise that the streets are there — it is the same
 * arithmetic the seeding does, exposed so the advice that follows a refusal can
 * be about a distance the grid actually supports rather than a number somebody
 * liked the sound of.
 */
export function lowestPredictedKnownness(
  start: LatLng,
  targetDistanceMeters: number,
  index: FamiliarityIndex,
  samples = 3,
): number | null {
  const candidates = buildUnfamiliarSeedCandidates(start, targetDistanceMeters, index, samples);
  const predictions = candidates
    .map((candidate) => candidate.predictedKnownness)
    .filter((value): value is number => typeof value === "number");

  return predictions.length === 0 ? null : Math.min(...predictions);
}

/** How finely the compass is probed when ranking directions by emptiness. */
const BEARING_PROBE_STEP = 6;
/** Seed directions taken per polygon resolution. */
const UNFAMILIAR_SEED_BEARINGS = 8;
/** How far apart those directions must be to count as different runs. */
const MIN_SEED_BEARING_SEPARATION = 30;
/** How far a waypoint may be pulled in or out along its spoke. */
const RADIAL_NUDGES = [0.82, 0.91, 1, 1.09, 1.18];

/** Every ring proposal, grouped by the direction it leaves the door in. */
function buildRingCandidates(start: LatLng, targetDistanceMeters: number): CandidateWaypoints[][] {
  const bearingStep = targetDistanceMeters <= 5000 ? 18 : targetDistanceMeters <= 12000 ? 15 : 12;
  const wobbleSets = [
    [0, 0, 0, 0, 0, 0],
    [0, 4, -4, 6, -6, 3],
    [0, -6, 5, -5, 4, -3],
  ];

  const byBearing: CandidateWaypoints[][] = [];

  for (let baseBearing = 0; baseBearing < 360; baseBearing += bearingStep) {
    const bucket: CandidateWaypoints[] = [];

    for (const shape of SHAPES) {
      const unitPathLength = normalizedPathLength(shape);
      const idealRadius = Math.max(170, targetDistanceMeters / unitPathLength);

      for (const radiusMultiplier of LENGTH_HEDGES) {
        for (const wobble of wobbleSets) {
          bucket.push({
            seed: `${shape.name}:${baseBearing}:${radiusMultiplier}:${wobble.join(",")}`,
            waypoints: shape.points.map((point, idx) => {
              const angle = (baseBearing + point.angle + wobble[idx % wobble.length] + 360) % 360;
              return destinationPoint(start, angle, idealRadius * radiusMultiplier * point.scale);
            }),
          });
        }
      }
    }

    byBearing.push(bucket);
  }

  return byBearing;
}

/**
 * Which ring proposals are worth a routing call.
 *
 * Taken in generation order, a budget of twenty bought twenty variations of one
 * compass bearing — five shapes, four radii and three wobbles all pointing the
 * same way — so "evenly spaced bearings" was never even what got routed. Round
 * robin over the bearings first, so the shortlist spans the compass, and then,
 * when there is a history to read, rank that shortlist by how close its
 * predicted familiarity comes to what was actually asked for.
 */
function selectRingCandidates(
  byBearing: CandidateWaypoints[][],
  limit: number,
  start: LatLng,
  familiarityMode: FamiliarityMode,
  index: FamiliarityIndex | null,
): CandidateWaypoints[] {
  if (limit <= 0) return [];

  const spread: CandidateWaypoints[] = [];
  const deepest = byBearing.reduce((max, bucket) => Math.max(max, bucket.length), 0);
  const pool = Math.min(limit * RANKING_POOL_FACTOR, byBearing.reduce((sum, bucket) => sum + bucket.length, 0));

  for (let depth = 0; depth < deepest && spread.length < pool; depth += 1) {
    for (const bucket of byBearing) {
      if (depth < bucket.length) spread.push(bucket[depth]);
      if (spread.length >= pool) break;
    }
  }

  if (!index || index.familiarSegments.length === 0) return spread.slice(0, limit);

  const band = familiarityRangeForMode(familiarityMode);
  const bandCentre = (band.min + band.max) / 2;

  return spread
    .map((candidate) => ({
      ...candidate,
      predictedKnownness: estimatePathKnownness([start, ...candidate.waypoints, start], index),
    }))
    .sort(
      (a, b) =>
        Math.abs((a.predictedKnownness ?? bandCentre) - bandCentre) -
        Math.abs((b.predictedKnownness ?? bandCentre) - bandCentre),
    )
    .slice(0, limit);
}

/** How many proposals are ranked for every one that is kept. */
const RANKING_POOL_FACTOR = 5;

export function buildLoopWaypointCandidates(
  start: LatLng,
  targetDistanceMeters: number,
  maxCandidates: number,
  familiarityMode: FamiliarityMode = "mixed",
  trackCollections: LatLng[][] = [],
  familiarityIndex: FamiliarityIndex | null = null,
): CandidateWaypoints[] {
  const results: CandidateWaypoints[] = [];

  if (familiarityMode === "familiar" && trackCollections.length > 0) {
    results.push(...buildFamiliarSeedCandidates(start, targetDistanceMeters, trackCollections, Math.min(48, maxCandidates)));
  }

  if (familiarityMode === "new" && familiarityIndex) {
    results.push(
      ...buildUnfamiliarSeedCandidates(
        start,
        targetDistanceMeters,
        familiarityIndex,
        Math.min(UNFAMILIAR_SEED_SHARE, Math.max(1, Math.ceil(maxCandidates * UNFAMILIAR_SEED_FRACTION))),
      ),
    );
  }

  results.push(
    ...selectRingCandidates(
      buildRingCandidates(start, targetDistanceMeters),
      maxCandidates - results.length,
      start,
      familiarityMode,
      familiarityIndex,
    ),
  );

  return results.slice(0, maxCandidates);
}

/**
 * How much of the shortlist targeted seeding may take.
 *
 * Not all of it. The rings are the fallback for everything the grid cannot see
 * — a history too sparse to rank directions with, or new ground that simply is
 * not where the grid says it should be — and leaving room for them is what stops
 * a confident wrong aim from returning nothing at all.
 */
const UNFAMILIAR_SEED_SHARE = 10;
const UNFAMILIAR_SEED_FRACTION = 0.75;
