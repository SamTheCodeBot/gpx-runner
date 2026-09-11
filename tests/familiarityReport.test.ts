import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildFamiliarityReport,
  familiarityBand,
  toEngineMode,
  toFamiliarityTarget,
} from "../src/engine/familiarityReport";

describe("familiarity target mapping", () => {
  it("maps the product vocabulary onto the engine vocabulary", () => {
    assert.equal(toEngineMode("unfamiliar"), "new");
    assert.equal(toEngineMode("familiar"), "familiar");
    assert.equal(toEngineMode("mixed"), "mixed");
    assert.equal(toFamiliarityTarget("new"), "unfamiliar");
    assert.deepEqual(familiarityBand("familiar"), { min: 0.8, max: 1 });
    assert.deepEqual(familiarityBand("unfamiliar"), { min: 0, max: 0.2 });
  });
});

describe("buildFamiliarityReport", () => {
  it("reports a familiar route inside the band", () => {
    const report = buildFamiliarityReport({ ratio: 0.92, target: "familiar", hasHistory: true });
    assert.equal(report.withinTarget, true);
    assert.equal(report.percent, 92);
    assert.match(report.message, /92%/);
  });

  it("tells the user plainly when a familiar request landed in between", () => {
    const report = buildFamiliarityReport({ ratio: 0.61, target: "familiar", hasHistory: true });
    assert.equal(report.withinTarget, false);
    assert.equal(report.percent, 61);
    assert.match(report.message, /61% familiar/);
  });

  it("tells the user plainly when an unfamiliar request landed in between", () => {
    const report = buildFamiliarityReport({ ratio: 0.55, target: "unfamiliar", hasHistory: true });
    assert.equal(report.withinTarget, false);
    assert.match(report.message, /not enough new ground/);
  });

  it("accepts a mixed route anywhere between the two thresholds", () => {
    for (const ratio of [0.2, 0.5, 0.8]) {
      assert.equal(buildFamiliarityReport({ ratio, target: "mixed", hasHistory: true }).withinTarget, true);
    }
    assert.equal(buildFamiliarityReport({ ratio: 0.19, target: "mixed", hasHistory: true }).withinTarget, false);
    assert.equal(buildFamiliarityReport({ ratio: 0.81, target: "mixed", hasHistory: true }).withinTarget, false);
  });

  it("never claims a percentage when there is no history near the start", () => {
    const report = buildFamiliarityReport({ ratio: null, target: "familiar", hasHistory: false });
    assert.equal(report.ratio, null);
    assert.equal(report.percent, null);
    assert.equal(report.withinTarget, false);
    assert.match(report.message, /could not be measured/);
  });

  it("clamps out-of-range ratios instead of reporting nonsense", () => {
    assert.equal(buildFamiliarityReport({ ratio: 1.4, target: "familiar", hasHistory: true }).percent, 100);
    assert.equal(buildFamiliarityReport({ ratio: -0.3, target: "unfamiliar", hasHistory: true }).percent, 0);
  });
});
