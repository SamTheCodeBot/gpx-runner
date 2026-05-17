import { LatLng, RouteSegment } from "../../types";

const EARTH_RADIUS_M = 6371000;

export function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

export function toDegrees(value: number): number {
  return (value * 180) / Math.PI;
}

/** Sum of haversine distances along a chain of points — i.e. what ORS would return if it ignored all intermediate waypoints and just connected them in order */
export function computeStraightLineDistance(points: LatLng[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += haversineMeters(points[i], points[i + 1]);
  }
  return total;
}

export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const aa = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
  return EARTH_RADIUS_M * c;
}

export function destinationPoint(start: LatLng, bearingDeg: number, distanceMeters: number): LatLng {
  const brng = toRadians(bearingDeg);
  const lat1 = toRadians(start.lat);
  const lng1 = toRadians(start.lng);
  const angularDistance = distanceMeters / EARTH_RADIUS_M;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(brng),
  );

  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
    );

  return { lat: toDegrees(lat2), lng: toDegrees(lng2) };
}

export function polylineDistanceMeters(points: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += haversineMeters(points[i - 1], points[i]);
  }
  return total;
}

export function toSegments(points: LatLng[]): RouteSegment[] {
  const segments: RouteSegment[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1];
    const to = points[i];
    segments.push({ from, to, distanceMeters: haversineMeters(from, to) });
  }
  return segments;
}

export function midpoint(a: LatLng, b: LatLng): LatLng {
  return { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
}

export function pointToSegmentDistanceMeters(point: LatLng, a: LatLng, b: LatLng): number {
  const latScale = 111320;
  const lngScale = 111320 * Math.cos(toRadians((a.lat + b.lat + point.lat) / 3));

  const px = (point.lng - a.lng) * lngScale;
  const py = (point.lat - a.lat) * latScale;
  const bx = (b.lng - a.lng) * lngScale;
  const by = (b.lat - a.lat) * latScale;

  const denom = bx * bx + by * by;
  if (denom === 0) return Math.sqrt(px * px + py * py);

  const t = Math.max(0, Math.min(1, (px * bx + py * by) / denom));
  const projX = bx * t;
  const projY = by * t;
  const dx = px - projX;
  const dy = py - projY;
  return Math.sqrt(dx * dx + dy * dy);
}

export function normalizeLoop(points: LatLng[]): LatLng[] {
  if (points.length < 2) return points;
  const first = points[0];
  const last = points[points.length - 1];
  if (haversineMeters(first, last) < 20) return points;
  return [...points, first];
}

export function densifyPolyline(points: LatLng[], stepMeters = 25): LatLng[] {
  if (points.length < 2) return points;
  const out: LatLng[] = [points[0]];

  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1];
    const to = points[i];
    const dist = haversineMeters(from, to);
    const steps = Math.max(1, Math.ceil(dist / stepMeters));
    for (let s = 1; s < steps; s += 1) {
      const t = s / steps;
      out.push({
        lat: from.lat + (to.lat - from.lat) * t,
        lng: from.lng + (to.lng - from.lng) * t,
      });
    }
    out.push(to);
  }

  return out;
}

export function simplifyByDistance(points: LatLng[], minStepMeters = 18): LatLng[] {
  if (points.length < 2) return points;
  const out: LatLng[] = [points[0]];
  let last = points[0];

  for (let i = 1; i < points.length - 1; i += 1) {
    if (haversineMeters(last, points[i]) >= minStepMeters) {
      out.push(points[i]);
      last = points[i];
    }
  }

  const finalPoint = points[points.length - 1];
  if (out[out.length - 1] !== finalPoint) out.push(finalPoint);
  return out;
}

export function canonicalPointKey(point: LatLng, decimals = 4): string {
  return `${point.lat.toFixed(decimals)}:${point.lng.toFixed(decimals)}`;
}
