import { FamiliarityMode, LatLng } from "../types";
import { haversineMeters, destinationPoint, simplifyByDistance } from "./utils/geo";

export type CandidateWaypoints = {
  seed: string;
  waypoints: LatLng[];
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

function normalizedPerimeter(shape: ShapeTemplate): number {
  let total = 0;
  const points = shape.points;

  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const ax = Math.cos((a.angle * Math.PI) / 180) * a.scale;
    const ay = Math.sin((a.angle * Math.PI) / 180) * a.scale;
    const bx = Math.cos((b.angle * Math.PI) / 180) * b.scale;
    const by = Math.sin((b.angle * Math.PI) / 180) * b.scale;
    total += Math.hypot(ax - bx, ay - by);
  }

  return total;
}

function radiusMultipliers(mode: FamiliarityMode): number[] {
  switch (mode) {
    case "familiar":
      return [0.92, 0.98, 1.04, 1.1];
    case "new":
      return [0.98, 1.06, 1.14, 1.22];
    case "mixed":
    default:
      return [0.94, 1.0, 1.08, 1.16];
  }
}

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

export function buildLoopWaypointCandidates(
  start: LatLng,
  targetDistanceMeters: number,
  maxCandidates: number,
  familiarityMode: FamiliarityMode = "mixed",
  trackCollections: LatLng[][] = [],
): CandidateWaypoints[] {
  const results: CandidateWaypoints[] = [];

  if (familiarityMode === "familiar" && trackCollections.length > 0) {
    results.push(...buildFamiliarSeedCandidates(start, targetDistanceMeters, trackCollections, Math.min(48, maxCandidates)));
  }

  const bearingStep = targetDistanceMeters <= 5000 ? 18 : targetDistanceMeters <= 12000 ? 15 : 12;
  const wobbleSets = [
    [0, 0, 0, 0, 0, 0],
    [0, 4, -4, 6, -6, 3],
    [0, -6, 5, -5, 4, -3],
  ];

  for (const shape of SHAPES) {
    const unitPerimeter = normalizedPerimeter(shape);
    const idealRadius = Math.max(170, targetDistanceMeters / unitPerimeter);

    for (let baseBearing = 0; baseBearing < 360; baseBearing += bearingStep) {
      for (const radiusMultiplier of radiusMultipliers(familiarityMode)) {
        for (const wobble of wobbleSets) {
          const waypoints = shape.points.map((point, idx) => {
            const angle = (baseBearing + point.angle + wobble[idx % wobble.length] + 360) % 360;
            const radius = idealRadius * radiusMultiplier * point.scale;
            return destinationPoint(start, angle, radius);
          });

          results.push({
            seed: `${shape.name}:${baseBearing}:${radiusMultiplier}:${wobble.join(",")}`,
            waypoints,
          });

          if (results.length >= maxCandidates) {
            return results;
          }
        }
      }
    }
  }

  return results;
}
