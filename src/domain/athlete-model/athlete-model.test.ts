import { describe, expect, it } from "vitest";
import {
  buildAthleteModel,
  computeBaseline,
  deviationFrom,
  DEFAULT_HALF_LIVES_H,
  DEFAULT_TOLERANCE,
} from "./index";

describe("athlete model", () => {
  it("merges learned overrides over defaults", () => {
    const m = buildAthleteModel({
      "fatigue_half_life.muscular_lower": 42,
      "exercise_cost.wall_ball": 1.4,
      "tolerance.impact": 3.5,
      "junk.x": 1,
    });
    expect(m.halfLivesH.muscular_lower).toBe(42);
    expect(m.halfLivesH.cardiovascular).toBe(DEFAULT_HALF_LIVES_H.cardiovascular);
    expect(m.tolerance.impact).toBe(3.5);
    expect(m.tolerance.muscular_lower).toBe(DEFAULT_TOLERANCE.muscular_lower);
    expect(m.exerciseCostMultipliers.wall_ball).toBe(1.4);
  });

  it("derives impact tolerance from history with a floor", () => {
    expect(buildAthleteModel({}, { meanWeeklyImpactIU: 5 }).impactWeeklyToleranceIU).toBe(12);
    expect(buildAthleteModel({}, { meanWeeklyImpactIU: 20 }).impactWeeklyToleranceIU).toBe(24);
  });

  it("computes robust baselines and deviations", () => {
    const b = computeBaseline("resting_hr", [50, 51, 49, 52, 50, 60, 50, 51], { center: "median" });
    expect(b?.center).toBe(50.5);
    const d = deviationFrom(b!, 57);
    expect(d.direction).toBe("above");
    expect(d.delta).toBeCloseTo(6.5);
  });

  it("refuses baselines with too few samples", () => {
    expect(computeBaseline("hrv", [40, 42])).toBeNull();
  });
});
