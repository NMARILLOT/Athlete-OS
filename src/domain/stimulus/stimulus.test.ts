import { describe, expect, it } from "vitest";
import { STIMULUS_KEY_VALUES } from "../core";
import { stimulusWeight, normalizeGoalWeights } from "./affinity";
import { computeLedger, rankGaps } from "./ledger";
import { DEFAULT_TARGETS, deriveWeeklyTargets, weeklyHardExposures } from "./targets";
import { patternExposure72h, weeklyPatternHeatmap } from "./exposure";

const NICOLAS = { health_longevity: 1, crossfit: 0.9, endurance: 0.9, strength: 0.9, physique: 0.6, fun: 0.7 };

describe("stimulus weights", () => {
  it("normalises goal weights to max 1", () => {
    expect(normalizeGoalWeights({ crossfit: 2, strength: 1 })).toEqual({ crossfit: 1, strength: 0.5 });
  });
  it("floors every stimulus at 0.5 (spec §36)", () => {
    for (const k of STIMULUS_KEY_VALUES) expect(stimulusWeight(k, {})).toBe(0.5);
    expect(stimulusWeight("crossfit_exposure", NICOLAS)).toBeGreaterThan(stimulusWeight("hypertrophy", NICOLAS));
  });
});

describe("weekly targets", () => {
  it("defaults respect the hard-session budget", () => {
    expect(weeklyHardExposures(DEFAULT_TARGETS)).toBeLessThanOrEqual(3);
  });

  it("never drops a key below 50 % of default across blocks", () => {
    for (const focus of ["base", "build", "performance", "custom"] as const) {
      const t = deriveWeeklyTargets({ goalWeights: NICOLAS, blockFocus: focus });
      for (const k of STIMULUS_KEY_VALUES) expect(t[k]).toBeGreaterThanOrEqual(DEFAULT_TARGETS[k] * 0.5 - 1e-9);
      expect(weeklyHardExposures(t)).toBeLessThanOrEqual(3 + 1e-9);
    }
  });

  it("scales hard keys down when overrides exceed the budget", () => {
    const t = deriveWeeklyTargets({ goalWeights: NICOLAS, overrides: { hi_conditioning: 4, threshold: 2, vo2max: 2 } });
    expect(weeklyHardExposures(t)).toBeLessThanOrEqual(3 + 1e-9);
  });

  it("applies deload multipliers and a single hard slot", () => {
    const t = deriveWeeklyTargets({ goalWeights: NICOLAS, deloadActive: true });
    expect(t.mobility_recovery).toBeGreaterThan(DEFAULT_TARGETS.mobility_recovery);
    expect(t.strength_lower).toBeLessThan(DEFAULT_TARGETS.strength_lower);
    expect(weeklyHardExposures(t)).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("raises specific stimuli for strong specific goals", () => {
    const t = deriveWeeklyTargets({ goalWeights: { ...NICOLAS, skill_muscle_up: 1 } });
    expect(t.gymnastics_skill).toBeGreaterThan(DEFAULT_TARGETS.gymnastics_skill);
  });
});

describe("exposure ledger", () => {
  const today = "2026-10-01"; // Thursday
  it("counts rolling windows, projects fixed classes and ranks gaps", () => {
    const ledger = computeLedger({
      today,
      targets: DEFAULT_TARGETS,
      history: [
        { date: "2026-09-28", credits: { strength_lower: 1, crossfit_exposure: 1, hi_conditioning: 0.8 } },
        { date: "2026-09-29", credits: { aerobic_easy: 1 } },
        { date: "2026-09-20", credits: { vo2max: 1 } }, // inside the 14-day window
        { date: "2026-09-10", credits: { threshold: 1 } }, // outside
      ],
      plannedFixed: [
        { date: "2026-10-02", credits: { crossfit_exposure: 1, hi_conditioning: 0.7 } },
        { date: "2026-10-05", credits: { crossfit_exposure: 1 } }, // next week → ignored
      ],
    });
    expect(ledger.strength_lower.credits).toBe(1);
    expect(ledger.strength_lower.gap).toBe(1);
    expect(ledger.vo2max.credits).toBe(1);
    expect(ledger.threshold.credits).toBe(0);
    expect(ledger.crossfit_exposure.plannedFixedCredits).toBe(1);
    expect(ledger.crossfit_exposure.projectedGap).toBe(1);
    expect(ledger.strength_lower.stalenessDays).toBe(3);
    expect(ledger.aerobic_easy.stalenessDays).toBe(2);
    expect(ledger.olympic_technique.stalenessDays).toBeNull();
    const ranked = rankGaps(ledger);
    expect(ranked[0]?.key).toBeDefined();
    expect(ranked.every((e) => e.projectedGap > 0)).toBe(true);
  });

  it("urgency rises late in the week", () => {
    const mon = computeLedger({ today: "2026-09-28", targets: DEFAULT_TARGETS, history: [] });
    const sun = computeLedger({ today: "2026-10-04", targets: DEFAULT_TARGETS, history: [] });
    expect(sun.aerobic_easy.urgency).toBeGreaterThan(mon.aerobic_easy.urgency);
    expect(sun.aerobic_easy.urgency).toBe(1.5);
  });
});

describe("exposure maps", () => {
  it("weights the last 72 h and builds heatmap bars", () => {
    const sessions = [
      { date: "2026-10-01", patternExposure: { squat: 3 }, muscleExposure: { quads: 4 } },
      { date: "2026-09-30", patternExposure: { squat: 3 }, muscleExposure: { quads: 4 } },
      { date: "2026-09-27", patternExposure: { squat: 3 }, muscleExposure: { quads: 4 } },
    ];
    expect(patternExposure72h(sessions, "2026-10-01").squat).toBeCloseTo(3 + 1.8);
    const heat = weeklyPatternHeatmap(sessions, "2026-09-28", "2026-10-04");
    expect(heat.find((r) => r.key === "squat")?.value).toBe(6);
    expect(heat.find((r) => r.key === "squat")?.bars).toBe(4);
  });
});
