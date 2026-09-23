import "./helpers/alias";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decodePolyline,
  encodePolyline,
  readTrackCoordinates,
  storedTrackLength,
  toStoredTrack,
} from "@/lib/track/polyline";

/**
 * The track is the only unbounded field on a route document, and it just
 * changed storage shape. These tests exist for two questions: does the geometry
 * survive the round trip closely enough for everything downstream, and can a
 * document written before the change still be read.
 */

/** A plausible Falkenberg run: a few kilometres of wandering, point per second. */
function syntheticRun(points: number): [number, number][] {
  const coordinates: [number, number][] = [];
  let lon = 12.4912;
  let lat = 56.9055;
  for (let i = 0; i < points; i += 1) {
    lon += Math.sin(i / 37) * 0.00012;
    lat += Math.cos(i / 53) * 0.00009;
    coordinates.push([Number(lon.toFixed(7)), Number(lat.toFixed(7))]);
  }
  return coordinates;
}

/** Metres between two points, good enough for an error bound. */
function metresApart(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(a[0] - b[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

describe("track polyline storage", () => {
  it("round-trips a long run inside the precision nothing downstream can see", () => {
    const original = syntheticRun(4000);
    const decoded = decodePolyline(encodePolyline(original));

    assert.equal(decoded.length, original.length);

    let worst = 0;
    for (let i = 0; i < original.length; i += 1) {
      worst = Math.max(worst, metresApart(original[i], decoded[i]));
    }
    // Precision 5 is ~1.1 m. The coarsest consumer simplifies to 30 m.
    assert.ok(worst < 1.5, `worst point moved ${worst.toFixed(3)} m`);
  });

  it("is far smaller than the array of maps it replaces", () => {
    const original = syntheticRun(4000);
    const asMaps = JSON.stringify(original.map(([lon, lat]) => ({ lat, lon })));
    const asPolyline = encodePolyline(original);

    assert.ok(
      asPolyline.length * 4 < asMaps.length,
      `polyline ${asPolyline.length} B vs array ${asMaps.length} B - expected at least 4x`,
    );
  });

  it("keeps the run's start and end exactly where the runner left them", () => {
    const original = syntheticRun(500);
    const decoded = decodePolyline(encodePolyline(original));

    assert.ok(metresApart(original[0], decoded[0]) < 1.5);
    assert.ok(
      metresApart(original[original.length - 1], decoded[decoded.length - 1]) < 1.5,
    );
  });

  it("reads a document written before the change, unmigrated", () => {
    const legacy = {
      coordinates: [
        { lat: 56.9055, lon: 12.4912 },
        { lat: 56.9061, lon: 12.4925 },
      ],
    };

    const coordinates = readTrackCoordinates(legacy);
    assert.deepEqual(coordinates, [
      [12.4912, 56.9055],
      [12.4925, 56.9061],
    ]);
    assert.equal(storedTrackLength(legacy), 2);
  });

  it("reads a document written after the change", () => {
    const stored = { track: toStoredTrack(syntheticRun(120)) };

    assert.equal(storedTrackLength(stored), 120);
    assert.equal(readTrackCoordinates(stored).length, 120);
  });

  it("treats a document with no geometry as empty rather than throwing", () => {
    assert.deepEqual(readTrackCoordinates({}), []);
    assert.deepEqual(readTrackCoordinates(null), []);
    assert.equal(storedTrackLength(undefined), 0);
    assert.deepEqual(decodePolyline(""), []);
  });

  it("survives a track with a single point", () => {
    const one: [number, number][] = [[12.4912, 56.9055]];
    const decoded = decodePolyline(encodePolyline(one));
    assert.equal(decoded.length, 1);
    assert.ok(metresApart(one[0], decoded[0]) < 1.5);
  });
});
