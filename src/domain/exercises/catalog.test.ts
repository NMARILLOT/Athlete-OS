import { describe, expect, it } from "vitest";
import { EXERCISE_CATALOG, getExercise, BENCHMARK_LIFT_IDS } from "./catalog";
import { listAliasPairs, normalizeMovementName, resolveExercise } from "./resolver";

describe("exercise catalog integrity", () => {
  it("has unique ids", () => {
    const ids = EXERCISE_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has aliases that map to a single exercise each", () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const [alias, id] of listAliasPairs()) {
      const n = normalizeMovementName(alias);
      const prev = seen.get(n);
      if (prev && prev !== id) collisions.push(`${alias} → ${prev} / ${id}`);
      seen.set(n, id);
    }
    expect(collisions).toEqual([]);
  });

  it("uses only slug ids", () => {
    for (const e of EXERCISE_CATALOG) expect(e.id).toMatch(/^[a-z0-9_]+$/);
  });

  it("tracks the spec §18 benchmark lifts", () => {
    for (const id of [
      "clean",
      "clean_and_jerk",
      "snatch",
      "front_squat",
      "back_squat",
      "deadlift",
      "bench_press",
      "strict_press",
      "push_press",
      "pull_up",
      "chest_to_bar",
      "toes_to_bar",
      "ring_muscle_up",
      "double_under",
    ]) {
      expect(BENCHMARK_LIFT_IDS).toContain(id);
    }
  });

  it("gives every exercise a non-empty primary muscle list and a cost", () => {
    for (const e of EXERCISE_CATALOG) {
      expect(e.primaryMuscles.length).toBeGreaterThan(0);
      expect(e.cost.lower + e.cost.upper + e.cost.cardio).toBeGreaterThan(0);
    }
  });
});

describe("resolveExercise", () => {
  it("resolves spec §66 aliases DL / dead lift / deadlift", () => {
    expect(resolveExercise("DL")?.exercise.id).toBe("deadlift");
    expect(resolveExercise("dead lift")?.exercise.id).toBe("deadlift");
    expect(resolveExercise("Deadlift")?.exercise.id).toBe("deadlift");
    expect(resolveExercise("Deadlifts")?.exercise.id).toBe("deadlift");
  });

  it("strips loads, Rx markers and accents", () => {
    expect(resolveExercise("Back Squat @ 100kg")?.exercise.id).toBe("back_squat");
    expect(resolveExercise("Wall balls 9/6 kg")?.exercise.id).toBe("wall_ball");
    expect(resolveExercise("Soulevé de terre")?.exercise.id).toBe("deadlift");
    expect(resolveExercise("Épaulé-jeté")?.exercise.id).toBe("clean_and_jerk");
    expect(resolveExercise("C2B Rx")?.exercise.id).toBe("chest_to_bar");
  });

  it("resolves monostructural calorie/meter phrasing", () => {
    expect(resolveExercise("cal row")?.exercise.id).toBe("row");
    expect(resolveExercise("250m row")?.exercise.id).toBe("row");
    expect(resolveExercise("calories bike")?.exercise.id).toBe("bike_erg");
    expect(resolveExercise("Echo bike")?.exercise.id).toBe("assault_bike");
    expect(resolveExercise("400m run")?.exercise.id).toBe("run");
  });

  it("fuzzy-matches near misses but not nonsense", () => {
    expect(resolveExercise("kipping chest to bar pull ups")?.exercise.id).toBe("chest_to_bar");
    expect(resolveExercise("heavy dumbbell hang power cleans")?.exercise.id).toBe("dumbbell_clean");
    expect(resolveExercise("xyzzy plugh")).toBeNull();
  });

  it("returns 1.0 confidence only for exact matches", () => {
    const exact = resolveExercise("thruster");
    expect(exact?.confidence).toBe(1);
    const fuzzy = resolveExercise("thruster then rest");
    expect(fuzzy?.exercise.id).toBe("thruster");
    expect(fuzzy?.confidence).toBeLessThan(1);
  });

  it("exposes catalog lookups", () => {
    expect(getExercise("back_squat")?.movementPattern).toBe("squat");
    expect(getExercise("nope")).toBeUndefined();
  });
});
