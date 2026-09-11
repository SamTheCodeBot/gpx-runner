import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildRouteGpx, parseGpxTrackPoints } from "../src/engine/gpx";

const POINTS = [
  { lat: 56.9, lng: 12.5, elevation: 12.3 },
  { lat: 56.901, lng: 12.501, elevation: 14.8 },
  { lat: 56.902, lng: 12.502 },
];

describe("buildRouteGpx", () => {
  it("writes a planned route as a course: no fake trackpoint timestamps", () => {
    const gpx = buildRouteGpx({ name: "Familiar loop", points: POINTS, createdAt: "2026-01-01T00:00:00.000Z" });

    assert.equal(/<trkpt[^>]*>[^<]*<[^>]*>\s*<time>/.test(gpx), false);
    assert.equal(gpx.includes("<trkpt"), true);
    // Exactly one <time>, the metadata one.
    assert.equal(gpx.match(/<time>/g)?.length, 1);
  });

  it("round-trips through the app's own GPX parser", () => {
    const gpx = buildRouteGpx({ name: "Familiar loop", points: POINTS });
    const parsed = parseGpxTrackPoints(gpx);

    assert.equal(parsed.name, "Familiar loop");
    assert.equal(parsed.points.length, 3);
    assert.ok(Math.abs(parsed.points[0].lat - 56.9) < 1e-6);
    assert.ok(Math.abs(parsed.points[0].lng - 12.5) < 1e-6);
    assert.equal(parsed.points[0].elevation, 12.3);
    assert.equal(parsed.points[2].elevation, undefined);
  });

  it("keeps real recorded timestamps for logged activities", () => {
    const gpx = buildRouteGpx({
      name: "Morning run",
      points: [
        { lat: 56.9, lng: 12.5, time: "2026-01-01T06:00:00.000Z" },
        { lat: 56.901, lng: 12.501, time: "2026-01-01T06:00:10.000Z" },
      ],
    });
    const parsed = parseGpxTrackPoints(gpx);

    assert.equal(parsed.points[0].time, "2026-01-01T06:00:00.000Z");
    assert.equal(parsed.points[1].time, "2026-01-01T06:00:10.000Z");
  });

  it("escapes names that would otherwise produce invalid XML", () => {
    const gpx = buildRouteGpx({ name: 'Tor & "Björn" <loop>', points: POINTS });

    assert.equal(gpx.includes("&amp;"), true);
    assert.equal(gpx.includes("<loop>"), false);
    assert.equal(parseGpxTrackPoints(gpx).points.length, 3);
  });

  it("skips coordinates that are not finite numbers", () => {
    const gpx = buildRouteGpx({
      name: "Broken",
      points: [...POINTS, { lat: Number.NaN, lng: 12.5 }],
    });
    assert.equal(parseGpxTrackPoints(gpx).points.length, 3);
  });
});
