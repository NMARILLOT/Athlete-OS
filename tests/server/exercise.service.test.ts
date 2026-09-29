import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import * as schema from "@/db/schema";
import { seedCatalog } from "@/db/seed";
import { createTestDb, type TestDb } from "@/db/test-db";
import { addDays } from "@/domain/core/dates";
import { NotFoundError } from "@/server/errors";
import { getExercisePage } from "@/server/services/exercise.service";

const USER_A = "00000000-0000-4000-8000-0000000000a8";
const USER_B = "00000000-0000-4000-8000-0000000000b8";
/** A Wednesday: the ISO week runs from the Monday two days before. */
const TODAY = "2026-09-30";

let handle: TestDb;

const PRESCRIPTION = {
  sets: 3,
  repMin: 5,
  repMax: 5,
  targetRpeMin: 7,
  targetRpeMax: 8.5,
  intent: "strength" as const,
  loadSuggestionKg: null,
  restSec: null,
};

interface Fixture {
  workoutId: string;
  workoutExerciseId: string;
}

async function workoutWithExercise(
  userId: string,
  date: string,
  exerciseId = "back_squat",
): Promise<Fixture> {
  const [w] = await handle.db
    .insert(schema.workouts)
    .values({ userId, type: "strength", source: "planned_user", status: "done", date, title: "S" })
    .returning();
  if (!w) throw new Error("workout insert failed");
  const [wx] = await handle.db
    .insert(schema.workoutExercises)
    .values({ userId, workoutId: w.id, date, order: 0, exerciseId, prescription: PRESCRIPTION })
    .returning();
  if (!wx) throw new Error("workout_exercises insert failed");
  return { workoutId: w.id, workoutExerciseId: wx.id };
}

async function addSets(
  userId: string,
  f: Fixture,
  date: string,
  sets: Array<{
    reps: number;
    weightKg: number;
    e1rmKg: number | null;
    rpe?: number;
    warmup?: boolean;
  }>,
  exerciseId = "back_squat",
) {
  await handle.db.insert(schema.strengthSets).values(
    sets.map((s, i) => ({
      userId,
      workoutId: f.workoutId,
      workoutExerciseId: f.workoutExerciseId,
      exerciseId,
      date,
      setIndex: i,
      reps: s.reps,
      weightKg: s.weightKg,
      rpe: s.rpe ?? null,
      e1rmKg: s.e1rmKg,
      isWarmup: s.warmup ?? false,
      completedAt: new Date(`${date}T17:${String(10 + i).padStart(2, "0")}:00Z`),
    })),
  );
}

beforeAll(async () => {
  handle = await createTestDb();
  await handle.db.insert(schema.users).values([
    { id: USER_A, email: "exercise-a@example.test", displayName: "A" },
    { id: USER_B, email: "exercise-b@example.test", displayName: "B" },
  ]);
  await seedCatalog(handle.db);

  // Fourteen back-squat workouts for A, one every 4 days, oldest first (so 12 are kept).
  for (let i = 13; i >= 0; i--) {
    const date = addDays(TODAY, -4 * i);
    const f = await workoutWithExercise(USER_A, date);
    const base = 90 + (13 - i) * 2; // progressive: 90 → 116 kg
    await addSets(USER_A, f, date, [
      { reps: 5, weightKg: 50, e1rmKg: 58.5, warmup: true },
      { reps: 5, weightKg: base, e1rmKg: Math.round(base * (1 + 5 / 30) * 2) / 2, rpe: 8 },
      { reps: 5, weightKg: base + 2.5, e1rmKg: Math.round((base + 2.5) * (1 + 5 / 30) * 2) / 2 },
    ]);
  }
  // A also trained today (within the week: today is Wednesday, Monday's session counts too).
  const monday = addDays(TODAY, -2);
  const fMonday = await workoutWithExercise(USER_A, monday);
  await addSets(USER_A, fMonday, monday, [
    { reps: 3, weightKg: 120, e1rmKg: 132, rpe: 9 },
    { reps: 3, weightKg: 120, e1rmKg: 132 },
  ]);

  // PRs for A: an older superseded record higher than the current one (declared 1RM from before).
  await handle.db.insert(schema.personalRecords).values([
    {
      userId: USER_A,
      kind: "weight",
      exerciseId: "back_squat",
      value: 140,
      unit: "kg",
      reps: 1,
      achievedAt: new Date("2025-01-10T10:00:00Z"),
      source: "USER",
      estimated: false,
      superseded: true,
    },
    {
      userId: USER_A,
      kind: "e1rm",
      exerciseId: "back_squat",
      value: 132,
      unit: "kg",
      reps: 3,
      achievedAt: new Date(`${monday}T17:10:00Z`),
      workoutId: fMonday.workoutId,
      source: "CALCULATED",
      estimated: true,
      algorithmVersion: "e1rm_epley_v1",
    },
    {
      userId: USER_A,
      kind: "e1rm",
      exerciseId: "deadlift",
      value: 180,
      unit: "kg",
      reps: 3,
      achievedAt: new Date(`${TODAY}T10:00:00Z`),
      source: "CALCULATED",
      estimated: true,
    },
  ]);

  // B: a huge squat today that must never show up for A.
  const fB = await workoutWithExercise(USER_B, TODAY);
  await addSets(USER_B, fB, TODAY, [{ reps: 1, weightKg: 200, e1rmKg: 200 }]);
});

afterAll(async () => {
  await handle.close();
});

describe("getExercisePage", () => {
  it("throws NotFoundError for an id outside the catalog", async () => {
    await expect(getExercisePage(handle.db, USER_A, "not_a_lift", TODAY)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("derives the stats from the athlete's own working sets", async () => {
    const view = await getExercisePage(handle.db, USER_A, "back_squat", TODAY);
    expect(view.exerciseId).toBe("back_squat");
    expect(view.name).toBe("Back squat");
    expect(view.currentE1rmKg).toBe(138.5); // best of the last 28 days: today's 116 + 2.5 kg × 5
    expect(view.lastExposure).toBe(TODAY);
    expect(view.weeklySets).toBe(4); // Monday 2 + today 2 working sets; warm-ups excluded
    expect(view.recentPrKg).toBe(132);
    expect(view.recentPrEstimated).toBe(true); // e1RM-based record → rendered "≈" (spec §70)
    expect(view.bestPrKg).toBe(140);
    expect(view.bestPrEstimated).toBe(false); // declared 1RM
  });

  it("returns the last 20 working sets oldest-first with their e1RM", async () => {
    const view = await getExercisePage(handle.db, USER_A, "back_squat", TODAY);
    expect(view.recentLoads).toHaveLength(20);
    const last = view.recentLoads[view.recentLoads.length - 1];
    expect(last).toEqual({ date: TODAY, weightKg: 118.5, reps: 5, e1rmKg: 138.5 });
    expect(view.recentLoads.every((l) => l.weightKg >= 50)).toBe(true);
    expect(view.recentLoads.some((l) => l.weightKg === 50)).toBe(false); // warm-ups excluded
    const dates = view.recentLoads.map((l) => l.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it("groups the last 12 workouts with every set, newest first, in set order", async () => {
    const view = await getExercisePage(handle.db, USER_A, "back_squat", TODAY);
    expect(view.history).toHaveLength(12);
    expect(view.history[0]?.date).toBe(TODAY);
    expect(view.history[1]?.date).toBe(addDays(TODAY, -2));
    expect(view.history[11]?.date).toBe(addDays(TODAY, -40));
    const today = view.history[0];
    expect(today?.sets.map((s) => s.setIndex)).toEqual([0, 1, 2]);
    expect(today?.sets[0]).toMatchObject({ isWarmup: true, weightKg: 50, reps: 5 });
    expect(today?.sets[1]).toMatchObject({ rpe: 8, weightKg: 116, e1rmKg: 135.5 });
    expect(typeof today?.sets[1]?.completedAt).toBe("string");
  });

  it("never mixes users", async () => {
    const a = await getExercisePage(handle.db, USER_A, "back_squat", TODAY);
    expect(a.currentE1rmKg).not.toBe(200);
    expect(a.recentLoads.some((l) => l.weightKg === 200)).toBe(false);
    const b = await getExercisePage(handle.db, USER_B, "back_squat", TODAY);
    expect(b.currentE1rmKg).toBe(200);
    expect(b.weeklySets).toBe(1);
    expect(b.history).toHaveLength(1);
    expect(b.recentPrKg).toBeNull();
    expect(b.bestPrKg).toBeNull();
  });

  it("returns nulls and empties for a catalog exercise never trained", async () => {
    const view = await getExercisePage(handle.db, USER_A, "front_squat", TODAY);
    expect(view).toEqual({
      exerciseId: "front_squat",
      name: "Front squat",
      currentE1rmKg: null,
      recentPrKg: null,
      recentPrEstimated: false,
      bestPrKg: null,
      bestPrEstimated: false,
      lastExposure: null,
      weeklySets: 0,
      recentLoads: [],
      history: [],
    });
  });
});
