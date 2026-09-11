import "./helpers/alias";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LOOP_SHAPE_LIMITS, assessLoopShape } from "@/engine/scoring/quality";
import { destinationPoint, polylineDistanceMeters } from "@/engine/utils/geo";
import type { LatLng } from "@/types";
import { circleLoop, radiusForLoopDistance } from "./helpers/geometry";

/**
 * "Give the routes some kind of circle. Start at A and come back to A, but no
 * straight line back and forward."
 *
 * The trap here is where you measure roundness *from*. Measuring radii from the
 * start treats the runner's front door as the centre of the loop — but a run
 * that leaves the door and returns to it has the door on the ring. Measured
 * that way a flawless circular loop reads as radii from 0 to 2R and scores as
 * badly as an out-and-back, so the gate threw away every realistic route and
 * the endpoint answered "no loop route found from this start point".
 */

const DOOR: LatLng = { lat: 56.907, lng: 12.5072 };
const TARGET_METERS = 5_000;
const RADIUS = radiusForLoopDistance(TARGET_METERS);

/** What a real 5 km run from a house looks like: the door is on the ring. */
function doorToDoorLoop(points = 96): LatLng[] {
  const centre = destinationPoint(DOOR, 0, RADIUS);
  const loop: LatLng[] = [];
  for (let i = 0; i <= points; i += 1) {
    loop.push(destinationPoint(centre, 180 + (360 / points) * i, RADIUS));
  }
  return loop;
}

/** Straight out, turn round, straight back. Never acceptable. */
function outAndBack(points = 40): LatLng[] {
  const out: LatLng[] = [];
  for (let i = 0; i <= points; i += 1) {
    out.push(destinationPoint(DOOR, 90, (TARGET_METERS / 2) * (i / points)));
  }
  return [...out, ...out.slice(0, -1).reverse()];
}

describe("the loop shape gate", () => {
  it("accepts a loop that starts and ends at the runner's door", () => {
    const loop = doorToDoorLoop();
    const shape = assessLoopShape(loop, DOOR, TARGET_METERS);

    assert.equal(shape.ok, true, `a perfect door-to-door loop must pass: ${JSON.stringify(shape)}`);
    assert.ok(Math.abs(polylineDistanceMeters(loop) - TARGET_METERS) < 100);
    assert.ok(shape.angularCoverage >= LOOP_SHAPE_LIMITS.minAngularCoverage);
    assert.ok(shape.minRadiusRatio >= LOOP_SHAPE_LIMITS.minRadiusRatio);
    assert.ok(shape.centerCrossPenalty <= LOOP_SHAPE_LIMITS.maxCenterCrossPenalty);
  });

  it("still accepts a loop drawn around the start", () => {
    const shape = assessLoopShape(circleLoop(DOOR, RADIUS, 96), DOOR, TARGET_METERS);
    assert.equal(shape.ok, true);
  });

  it("refuses an out-and-back of exactly the right length", () => {
    const shape = assessLoopShape(outAndBack(), DOOR, TARGET_METERS);

    assert.equal(shape.ok, false);
    assert.ok(shape.outAndBackRatio > LOOP_SHAPE_LIMITS.maxOutAndBackRatio, "it retraces itself");
    assert.ok(shape.angularCoverage < LOOP_SHAPE_LIMITS.minAngularCoverage, "it only ever goes one way");
  });

  it("refuses a route that does not come back to the start", () => {
    // A proper ring, but the runner is left 400 m from the door.
    const loop = doorToDoorLoop();
    const open = loop.slice(0, Math.floor(loop.length * 0.92));

    const shape = assessLoopShape(open, DOOR, TARGET_METERS);
    assert.ok(
      shape.closureErrorMeters > LOOP_SHAPE_LIMITS.maxClosureErrorMeters,
      `closure error was ${shape.closureErrorMeters.toFixed(0)} m`,
    );
    assert.equal(shape.ok, false);
  });

  it("accepts a square loop from the door, and refuses a hairline sliver", () => {
    const side = TARGET_METERS / 4;
    const square: LatLng[] = [DOOR];
    let cursor = DOOR;
    for (const bearing of [0, 90, 180, 270]) {
      for (let step = 1; step <= 10; step += 1) {
        square.push(destinationPoint(cursor, bearing, (side * step) / 10));
      }
      cursor = square[square.length - 1];
    }
    assert.equal(assessLoopShape(square, DOOR, TARGET_METERS).ok, true);

    // 2400 m long, 100 m wide — closed, but nobody would call it a circle.
    const sliver: LatLng[] = [];
    const corners: Array<[number, number]> = [
      [90, 0],
      [90, 2_400],
      [0, 2_400],
    ];
    let point = DOOR;
    for (const [bearing, distance] of corners) {
      point = distance === 0 ? destinationPoint(DOOR, 0, 100) : destinationPoint(point, bearing, distance);
      sliver.push(point);
    }
    const sliverLoop = [DOOR, ...sliver, DOOR];
    assert.equal(assessLoopShape(sliverLoop, DOOR, TARGET_METERS).ok, false);
  });
});
