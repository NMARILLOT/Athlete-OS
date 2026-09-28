import { describe, expect, it } from "vitest";
import {
  E1RM_ALGORITHM_VERSION,
  bestE1rm,
  e1rmConfidence,
  estimateOneRepMax,
  roundToIncrement,
  weightForRepsAtRpe,
} from "./e1rm";
import { decideProgression } from "./progression";
import { adjustRestForQuality, restSecondsFor } from "./rest-timer";
import { STRENGTH_TEMPLATES } from "./templates";
import { StrengthPrescriptionSchema } from "./types";
import { getExercise } from "../exercises";

describe("e1RM (Epley v1)", () => {
  it("is version pinned", () => {
    expect(E1RM_ALGORITHM_VERSION).toBe("e1rm_epley_v1");
  });

  it("computes w × (1 + reps/30), rounded to 0.5", () => {
    expect(estimateOneRepMax(100, 5)).toBe(116.5);
    expect(estimateOneRepMax(92.5, 5)).toBe(108);
    expect(estimateOneRepMax(100, 1)).toBe(100);
  });

  it("refuses long sets and invalid input", () => {
    expect(estimateOneRepMax(100, 13)).toBeNull();
    expect(estimateOneRepMax(100, 0)).toBeNull();
    expect(estimateOneRepMax(0, 5)).toBeNull();
  });

  it("derives working weight for reps @ RPE", () => {
    // 5 reps @ RPE 8 ≈ 7 reps to failure → e1rm / (1 + 7/30)
    expect(weightForRepsAtRpe(120, 5, 8)).toBeCloseTo(120 / (1 + 7 / 30), 5);
  });

  it("grades confidence by reps and RPE", () => {
    expect(e1rmConfidence(3, 9)).toBe("HIGH");
    expect(e1rmConfidence(5, 6)).toBe("MEDIUM");
    expect(e1rmConfidence(10, 9)).toBe("LOW");
    expect(e1rmConfidence(15)).toBe("LOW");
  });

  it("picks the best working set", () => {
    const best = bestE1rm([
      { weightKg: 60, reps: 5, isWarmup: true },
      { weightKg: 100, reps: 5, rpe: 8 },
      { weightKg: 105, reps: 3, rpe: 9 },
    ]);
    expect(best?.weightKg).toBe(100);
    expect(best?.e1rmKg).toBe(116.5);
  });

  it("rounds to increments", () => {
    expect(roundToIncrement(101.2, 2.5)).toBe(100);
    expect(roundToIncrement(101.3, 2.5)).toBe(102.5);
    expect(roundToIncrement(41, 2)).toBe(42);
  });
});

describe("progression (autoload v1)", () => {
  const prescription = { sets: 3, repMin: 5, repMax: 5, targetRpeMin: 7, targetRpeMax: 8.5 };

  it("increases when all sets hit the top with RIR", () => {
    const d = decideProgression({
      prescription,
      incrementKg: 2.5,
      history: [
        {
          date: "2026-09-25",
          sets: [
            { reps: 5, weightKg: 90, rpe: 7 },
            { reps: 5, weightKg: 90, rpe: 7.5 },
            { reps: 5, weightKg: 90, rpe: 8 },
          ],
        },
      ],
    });
    expect(d.action).toBe("increase");
    expect(d.nextWeightKg).toBe(92.5);
    expect(d.deltaKg).toBe(2.5);
    expect(d.ruleId).toBe("ALL_SETS_TOP_OF_RANGE_WITH_RIR");
  });

  it("increases two steps when clearly too easy", () => {
    const d = decideProgression({
      prescription,
      incrementKg: 2.5,
      history: [
        {
          date: "2026-09-25",
          sets: [
            { reps: 5, weightKg: 90, quality: "easy" },
            { reps: 5, weightKg: 90, quality: "easy" },
            { reps: 5, weightKg: 90, rpe: 6 },
          ],
        },
      ],
    });
    expect(d.action).toBe("increase");
    expect(d.nextWeightKg).toBe(95);
  });

  it("holds when the target is met but hard", () => {
    const d = decideProgression({
      prescription,
      incrementKg: 2.5,
      history: [
        {
          date: "2026-09-25",
          sets: [
            { reps: 5, weightKg: 90, rpe: 8.5 },
            { reps: 5, weightKg: 90, rpe: 9 },
            { reps: 5, weightKg: 90, quality: "hard" },
          ],
        },
      ],
    });
    expect(d.action).toBe("hold");
    expect(d.nextWeightKg).toBe(90);
    expect(d.ruleId).toBe("TARGET_MET_BUT_HARD");
  });

  it("decreases when several sets miss", () => {
    const d = decideProgression({
      prescription,
      incrementKg: 2.5,
      history: [
        {
          date: "2026-09-25",
          sets: [
            { reps: 5, weightKg: 100, rpe: 9 },
            { reps: 4, weightKg: 100, rpe: 10 },
            { reps: 3, weightKg: 100, quality: "failed" },
          ],
        },
      ],
    });
    expect(d.action).toBe("decrease");
    expect(d.nextWeightKg).toBe(95);
    expect(d.ruleId).toBe("MULTIPLE_SETS_MISSED");
  });

  it("seeds the first exposure from a known e1RM", () => {
    const d = decideProgression({ prescription, incrementKg: 2.5, history: [], knownE1rmKg: 120 });
    expect(d.action).toBe("start");
    expect(d.nextWeightKg).toBe(roundToIncrement(weightForRepsAtRpe(120, 5, 7), 2.5));
  });

  it("asks the athlete when nothing is known", () => {
    const d = decideProgression({ prescription, incrementKg: 2.5, history: [] });
    expect(d.action).toBe("unknown");
    expect(d.nextWeightKg).toBeNull();
  });

  it("is deterministic (same input → same output)", () => {
    const input = {
      prescription,
      incrementKg: 2.5,
      history: [
        {
          date: "2026-09-25",
          sets: [
            { reps: 5, weightKg: 90, rpe: 7 },
            { reps: 5, weightKg: 90, rpe: 7 },
            { reps: 5, weightKg: 90, rpe: 7 },
          ],
        },
      ],
    };
    expect(decideProgression(input)).toEqual(decideProgression(input));
  });
});

describe("rest timer policy", () => {
  it("follows spec §78 ranges", () => {
    expect(restSecondsFor("strength")).toBeGreaterThanOrEqual(150);
    expect(restSecondsFor("strength")).toBeLessThanOrEqual(300);
    expect(restSecondsFor("hypertrophy")).toBeGreaterThanOrEqual(60);
    expect(restSecondsFor("hypertrophy")).toBeLessThanOrEqual(150);
    expect(restSecondsFor("circuit", 30)).toBe(30);
  });

  it("stretches rest after hard sets but caps at the policy max", () => {
    expect(adjustRestForQuality(180, "strength", "hard")).toBe(216);
    expect(adjustRestForQuality(280, "strength", "failed")).toBe(300);
    expect(adjustRestForQuality(90, "hypertrophy", "easy")).toBe(77);
  });
});

describe("strength templates", () => {
  it("reference only catalog exercises and valid prescriptions", () => {
    for (const t of STRENGTH_TEMPLATES) {
      for (const ex of t.exercises) {
        expect(getExercise(ex.exerciseId), ex.exerciseId).toBeDefined();
        expect(() => StrengthPrescriptionSchema.parse(ex.prescription)).not.toThrow();
        for (const alt of ex.alternates ?? []) expect(getExercise(alt), alt).toBeDefined();
      }
    }
  });
});
