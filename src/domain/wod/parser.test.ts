import { describe, expect, it } from "vitest";
import { parseWodText } from "./heuristic-parser";
import { NormalizedWodSchema } from "./schema";

describe("heuristic WOD parser", () => {
  it("parses the spec §4 WOD into a strength part and an AMRAP", () => {
    const w = parseWodText(
      "Back squat\n5 x 5 lourd\n\nPuis :\n\n12 min AMRAP\n12 wall balls\n10 burpees\n250 m row",
    );
    expect(w.parts).toHaveLength(2);
    const [s, m] = w.parts;
    expect(s?.kind).toBe("strength");
    expect(s?.format).toBe("sets_reps");
    expect(s?.sets).toBe(5);
    expect(s?.reps).toBe(5);
    expect(s?.movements[0]?.exerciseId).toBe("back_squat");
    expect(s?.movements[0]?.load?.qualifier).toBe("heavy");
    expect(m?.format).toBe("amrap");
    expect(m?.durationMin).toBe(12);
    expect(m?.movements.map((x) => [x.exerciseId, x.reps, x.distanceM])).toEqual([
      ["wall_ball", 12, null],
      ["burpee", 10, null],
      ["row", null, 250],
    ]);
    expect(w.parseConfidence).toBeGreaterThanOrEqual(0.8);
  });

  it("parses the spec §7 WOD with a 21-15-9 scheme and loads", () => {
    const w = parseWodText(
      "A) Deadlift 5x3 heavy\n\nB) For time\n21-15-9\ncal bike\ndeadlift 100/70 kg",
    );
    expect(w.parts[0]?.kind).toBe("strength");
    expect(w.parts[0]?.movements[0]?.sets).toBe(5);
    expect(w.parts[0]?.movements[0]?.reps).toBe(3);
    expect(w.parts[1]?.repScheme).toEqual([21, 15, 9]);
    expect(w.parts[1]?.movements[1]?.load).toMatchObject({ value: 100, alt: 70, unit: "kg" });
  });

  it("detects a benchmark title", () => {
    const w = parseWodText('"Fran"\nFor time:\n21-15-9\nThrusters 43/30\nPull-ups');
    expect(w.title).toBe("Fran");
    expect(w.parts[0]?.movements[0]?.load).toMatchObject({ value: 43, alt: 30 });
  });

  it("parses inline AMRAP with comma-separated movements", () => {
    const w = parseWodText("AMRAP 15: 5 pull ups, 10 push ups, 15 air squats");
    expect(w.parts[0]?.format).toBe("amrap");
    expect(w.parts[0]?.durationMin).toBe(15);
    expect(w.parts[0]?.movements.map((m) => m.exerciseId)).toEqual([
      "pull_up",
      "push_up",
      "air_squat",
    ]);
  });

  it("parses EMOM with minute labels as alternating", () => {
    const w = parseWodText(
      "Strength: Power clean 5x3 @ 80%\n\nEMOM 12 min\n1: 15 cal row\n2: 10 burpees over bar\n3: 12 KB swings 24/16",
    );
    expect(w.parts).toHaveLength(2);
    expect(w.parts[0]?.movements[0]?.load).toMatchObject({ value: 80, unit: "percent_1rm" });
    const e = w.parts[1]!;
    expect(e.format).toBe("emom");
    expect(e.alternating).toBe(true);
    expect(e.intervalSec).toBe(60);
    expect(e.movements[0]).toMatchObject({ exerciseId: "row", calories: 15 });
    expect(e.movements[1]).toMatchObject({ exerciseId: "bar_facing_burpee", reps: 10 });
    expect(e.movements[2]).toMatchObject({ exerciseId: "kettlebell_swing", reps: 12 });
  });

  it("parses rounds, caps and French wording", () => {
    const w = parseWodText("5 rounds for time (cap 20)\n400m run\n15 OHS 43/30\n15 C2B");
    expect(w.parts[0]).toMatchObject({ format: "for_time", rounds: 5, timeCapMin: 20 });
    const f = parseWodText(
      "Skill : 10 min handstand walk\nWOD : 4 tours\n20 DU\n10 fentes sautées\n8 tractions strictes\nrepos 1 min",
    );
    expect(f.parts[0]?.kind).toBe("skill");
    expect(f.parts[1]).toMatchObject({ kind: "metcon", rounds: 4, restSec: 60 });
    expect(f.parts[1]?.movements.map((m) => m.exerciseId)).toEqual([
      "double_under",
      "lunge",
      "strict_pull_up",
    ]);
    expect(f.parts[1]?.movements[1]?.modifiers).toContain("jumping");
  });

  it("captures pace words", () => {
    const w = parseWodText("30 min easy row");
    expect(w.parts[0]?.movements[0]).toMatchObject({
      exerciseId: "row",
      durationSec: 1800,
      pace: "easy",
    });
  });

  it("never throws on garbage and lowers confidence", () => {
    const w = parseWodText("Do something fun with the frisbee 20 min");
    expect(w.parts[0]?.movements[0]?.exerciseId).toBeNull();
    expect(w.parseConfidence).toBeLessThan(0.7);
    expect(() => NormalizedWodSchema.parse(w)).not.toThrow();
    expect(parseWodText("").parts.length).toBe(1);
  });

  it("rejects physiology keys at the schema boundary (Layer B guardrail)", () => {
    const w = parseWodText("Fran\n21-15-9\nthrusters\npull-ups");
    const poisoned = { ...w, parts: [{ ...w.parts[0], stimulus: "conditioning" }] };
    expect(NormalizedWodSchema.safeParse(poisoned).success).toBe(false);
    const poisonedMovement = {
      ...w,
      parts: [{ ...w.parts[0], movements: [{ ...w.parts[0]!.movements[0], muscles: ["quads"] }] }],
    };
    expect(NormalizedWodSchema.safeParse(poisonedMovement).success).toBe(false);
  });
});
