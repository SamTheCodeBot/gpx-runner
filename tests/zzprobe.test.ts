import "./helpers/alias";

import { describe, it } from "node:test";

import { buildLoopWaypointCandidates } from "@/engine/candidates";
import { buildFamiliarityIndex } from "@/engine/familiarity";
import { evaluateBuiltRoute } from "@/engine/generateRoute";
import { familiarityRangeForMode } from "@/engine/config";
import { haversineMeters, polylineDistanceMeters } from "@/engine/utils/geo";
import type { LatLng } from "@/types";
import { buildDenseFalkenbergHistory, routeAlongStreets, FALKENBERG_HOME } from "./helpers/streetGrid";

const START: LatLng = FALKENBERG_HOME;
const HISTORY = buildDenseFalkenbergHistory();

describe("PROBE candidate behaviour", () => {
  for (const km of [5.5, 8.5]) {
    it(`generic ring candidates at ${km} km`, () => {
      const target = km * 1000;
      const index = buildFamiliarityIndex(HISTORY);
      const seeded = process.env.SEEDED !== "0";
      const candidates = buildLoopWaypointCandidates(
        START,
        target,
        6,
        "new",
        HISTORY,
        seeded ? index : null,
      );

      let best = 1;
      let bestOk = 1;
      const rows: string[] = [];

      for (const candidate of candidates.slice(0, 20)) {
        const geometry = routeAlongStreets([START, ...candidate.waypoints, START]);
        const distance = polylineDistanceMeters(geometry);
        const built = evaluateBuiltRoute({
          geometry,
          requestedWaypoints: candidate.waypoints,
          distanceMeters: distance,
          source: "provider",
          seed: candidate.seed,
          input: { start: START, targetDistanceKm: km, familiarityMode: "new", routeCollections: HISTORY },
          familiarityIndex: index,
          targetMeters: target,
          targetFamiliarityRange: familiarityRangeForMode("new"),
        });
        best = Math.min(best, built.route.familiarityRatio);
        if (built.reasons.hardConstraintsOk && built.reasons.distanceOk) {
          bestOk = Math.min(bestOk, built.route.familiarityRatio);
        }
        rows.push(
          `${candidate.seed} dist=${Math.round(distance)} fam=${(built.route.familiarityRatio * 100).toFixed(0)}% ` +
            `distOk=${built.reasons.distanceOk} loopOk=${built.reasons.loopOk} safe=${built.reasons.safetyOk} ` +
            `round=${Number(built.route.debug.roundness).toFixed(2)} pred=${((candidate.predictedKnownness ?? -1) * 100).toFixed(0)}%`,
        );
      }

      // eslint-disable-next-line no-console
      console.log(`\n[PROBE ${km}km] candidates=${candidates.length}\n` + rows.slice(0, 12).join("\n"));
      // eslint-disable-next-line no-console
      console.log(`[PROBE ${km}km] best=${(best * 100).toFixed(0)}% bestAccepted=${(bestOk * 100).toFixed(0)}%`);
    });
  }

  it("history coverage by bearing", () => {
    const index = buildFamiliarityIndex(HISTORY);
    const rows: string[] = [];
    for (const radius of [500, 900, 1400, 2000, 2800]) {
      const cells: string[] = [];
      for (let bearing = 0; bearing < 360; bearing += 30) {
        let known = 0;
        let total = 0;
        for (let r = radius - 150; r <= radius + 150; r += 50) {
          const rad = (bearing * Math.PI) / 180;
          const point = {
            lat: START.lat + (r * Math.cos(rad)) / 111_320,
            lng: START.lng + (r * Math.sin(rad)) / (111_320 * Math.cos((START.lat * Math.PI) / 180)),
          };
          total += 1;
          const nearest = nearestDistance(point, index);
          if (nearest <= 35) known += 1;
        }
        cells.push(`${bearing}:${Math.round((known / total) * 100)}`);
      }
      rows.push(`r=${radius} ` + cells.join(" "));
    }
    // eslint-disable-next-line no-console
    console.log("\n[COVERAGE]\n" + rows.join("\n"));
    // eslint-disable-next-line no-console
    console.log(
      `[COVERAGE] segments=${index.familiarSegments.length} maxRadius=${Math.round(
        Math.max(...index.familiarSegments.map((s) => haversineMeters(START, s.from))),
      )}`,
    );
  });
});

function nearestDistance(point: LatLng, index: ReturnType<typeof buildFamiliarityIndex>): number {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { nearestFamiliarDistanceMeters } = require("@/engine/familiarity");
  return nearestFamiliarDistanceMeters(point, index);
}
