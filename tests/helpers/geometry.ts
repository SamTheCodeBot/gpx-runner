import { LatLng } from "../../src/types";
import { destinationPoint, polylineDistanceMeters } from "../../src/engine/utils/geo";

/**
 * Deterministic synthetic geometry for offline tests. No network, no API key.
 */

/** A closed regular polygon approximating a circle of `radiusMeters` around `center`. */
export function circleLoop(center: LatLng, radiusMeters: number, points = 48): LatLng[] {
  const loop: LatLng[] = [];
  for (let i = 0; i < points; i += 1) {
    loop.push(destinationPoint(center, (360 / points) * i, radiusMeters));
  }
  loop.push(loop[0]);
  return loop;
}

/** Radius that makes a circular loop `distanceMeters` long. */
export function radiusForLoopDistance(distanceMeters: number): number {
  return distanceMeters / (2 * Math.PI);
}

/** Half of a circular loop — used to build "partially known" history. */
export function halfCircleTrack(center: LatLng, radiusMeters: number, points = 48): LatLng[] {
  const loop = circleLoop(center, radiusMeters, points);
  return loop.slice(0, Math.floor(points / 2) + 1);
}

/** A straight line of `lengthMeters` heading `bearingDeg` from `from`. */
export function straightTrack(from: LatLng, bearingDeg: number, lengthMeters: number, step = 25): LatLng[] {
  const track: LatLng[] = [from];
  for (let travelled = step; travelled <= lengthMeters; travelled += step) {
    track.push(destinationPoint(from, bearingDeg, travelled));
  }
  return track;
}

export function loopDistance(points: LatLng[]): number {
  return polylineDistanceMeters(points);
}
