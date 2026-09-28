import { describe, expect, it } from "vitest";
import { analyzeWod } from "./analyzer";
import { parseWodText } from "./heuristic-parser";
import { NormalizedWodSchema } from "./schema";

const mv = (raw: string, exerciseId: string | null, extra: Record<string, unknown> = {}) => ({
  raw,
  exerciseId,
  name: raw,
  ...extra,
});
const base = { sourceText: "x", parseConfidence: 1, parser: "USER" as const, parserVersion: "t" };

describe("WOD analyzer", () => {
  it("spec §4: squat 5×5 + 12′ AMRAP → squat dominant, heavy legs, hard conditioning", () => {
    const wod = NormalizedWodSchema.parse({
      ...base,
      parts: [
        {
          kind: "strength",
          format: "sets_reps",
          sets: 5,
          reps: 5,
          movements: [
            mv("Back squat", "back_squat", { load: { value: 0, unit: "kg", qualifier: "heavy" } }),
          ],
        },
        {
          kind: "metcon",
          format: "amrap",
          durationMin: 12,
          movements: [
            mv("12 wall balls", "wall_ball", { reps: 12 }),
            mv("10 burpees", "burpee", { reps: 10 }),
            mv("250 m row", "row", { distanceM: 250 }),
          ],
        },
      ],
    });
    const a = analyzeWod(wod, { e1rms: { back_squat: 140 } });
    expect(a.tags).toContain("squat_dominant");
    expect(a.dominant).toBe("mixed");
    expect(a.intensity).toBe("hard");
    expect(a.timeDomain).toBe("medium");
    expect(a.loadVector.muscular_lower).toBeGreaterThanOrEqual(7.5);
    expect(a.loadVector.cardiovascular).toBeGreaterThanOrEqual(7);
    expect(a.loadVector.impact).toBeLessThan(4);
    expect(a.stimulusCredits.strength_lower).toBeGreaterThanOrEqual(1);
    expect(a.stimulusCredits.hi_conditioning).toBe(1);
    expect(a.stimulusCredits.crossfit_exposure).toBe(1);
    expect(a.energySystems).toContain("glycolytic");
    expect(a.modalities).toContain("row");
    expect(a.muscleExposure.quads).toBeGreaterThan(a.muscleExposure.chest ?? 0);
    expect(a.estimatedDurationMin).toBeGreaterThan(20);
    expect(a.confidence).toBe(1);
  });

  it("spec §7: deadlift 5×3 + 21-15-9 → hinge dominant, posterior chain, hard", () => {
    const a = analyzeWod(
      parseWodText("Deadlift 5x3 heavy\n\nFor time\n21-15-9\ncal bike\ndeadlift 100/70 kg"),
      { e1rms: { deadlift: 180 } },
    );
    expect(a.tags).toContain("hinge_dominant");
    expect(a.stimulusCredits.strength_lower).toBeGreaterThanOrEqual(0.8);
    expect(a.stimulusCredits.hi_conditioning).toBeGreaterThanOrEqual(0.7);
    expect(a.muscleExposure.hamstrings).toBeGreaterThan(a.muscleExposure.quads ?? 0);
    expect(a.movements.find((m) => m.exerciseId === "bike_erg")?.totalCalories).toBe(45);
    expect(a.movements.find((m) => m.exerciseId === "deadlift")?.totalReps).toBe(15 + 45);
  });

  it("Fran is short, hard, glycolytic with gymnastics skill credit", () => {
    const a = analyzeWod(parseWodText("Fran\nFor time\n21-15-9\nThrusters 43/30\nPull-ups"), {
      e1rms: { thruster: 80 },
    });
    expect(a.timeDomain).toBe("short");
    expect(a.intensity).toBe("hard");
    expect(a.energySystems).toContain("glycolytic");
    expect(a.stimulusCredits.hi_conditioning).toBe(0.7);
    expect(a.stimulusCredits.gymnastics_skill).toBeGreaterThan(0);
    expect(a.loadVector.technical).toBeLessThan(3);
  });

  it("an easy 30′ row is easy aerobic, not conditioning", () => {
    const a = analyzeWod(parseWodText("30 min easy row"), { isCrossfitSession: false });
    expect(a.intensity).toBe("easy");
    expect(a.loadVector.cardiovascular).toBeLessThan(3);
    expect(a.loadVector.muscular_lower).toBeLessThan(4);
    expect(a.stimulusCredits.hi_conditioning).toBeUndefined();
    expect(a.stimulusCredits.crossfit_exposure).toBeUndefined();
    expect(a.stimulusCredits.aerobic_easy).toBeGreaterThan(0.5);
  });

  it("tracks impact from double-unders and box jumps (spec §47)", () => {
    const a = analyzeWod(
      parseWodText("3 rounds for time\n50 double unders\n20 box jumps\n400 m run"),
    );
    expect(a.impactUnits).toBeGreaterThan(2);
    expect(a.loadVector.impact).toBeGreaterThan(2.5);
    expect(a.movements.find((m) => m.exerciseId === "double_under")?.totalReps).toBe(150);
  });

  it("credits olympic technique and power for a snatch day", () => {
    const a = analyzeWod(
      parseWodText("Snatch 6x2 @ 75%\n\nAMRAP 10\n50 DU\n10 box jumps\n5 power snatch 40 kg"),
    );
    expect(a.stimulusCredits.olympic_technique).toBeGreaterThan(0.5);
    expect(a.stimulusCredits.power).toBeGreaterThan(0.5);
    expect(a.modalities).toContain("weightlifting");
    expect(a.loadVector.technical).toBeGreaterThan(4);
  });

  it("alternating EMOM divides work across movements", () => {
    const alt = analyzeWod(parseWodText("EMOM 12\n1: 15 cal row\n2: 10 burpees\n3: 12 KB swings"));
    const rows = alt.movements.find((m) => m.exerciseId === "row")?.totalCalories ?? 0;
    expect(rows).toBe(60); // 4 rounds × 15 cal
  });

  it("unknown movements lower confidence and cap it at 0.6", () => {
    const wod = NormalizedWodSchema.parse({
      ...base,
      parts: [
        {
          kind: "metcon",
          format: "amrap",
          durationMin: 10,
          movements: [
            mv("10 frobnicates", null, {
              reps: 10,
              hintedPattern: "squat",
              resolutionConfidence: 0,
            }),
            mv("10 burpees", "burpee", { reps: 10 }),
          ],
        },
      ],
    });
    const a = analyzeWod(wod);
    expect(a.unknownMovements).toEqual(["10 frobnicates"]);
    expect(a.confidence).toBeLessThanOrEqual(0.6);
    expect(a.patternExposure.squat).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    const wod = parseWodText("Fran\n21-15-9\nthrusters 43/30\npull-ups");
    expect(analyzeWod(wod)).toEqual(analyzeWod(wod));
  });
});
