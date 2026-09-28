import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { seedCatalog } from "@/db/seed";
import { createTestDb, type TestDb } from "@/db/test-db";
import {
  applyStrengthEvents,
  bestE1rmsByExercise,
  createStrengthWorkoutFromTemplate,
  getStrengthBundle,
} from "@/server/services/strength-session.service";

vi.mock("server-only", () => ({}));

const USER_A = "00000000-0000-4000-8000-0000000000a1";
const USER_B = "00000000-0000-4000-8000-0000000000b1";
const TODAY = "2026-09-28";

let handle: TestDb;

beforeAll(async () => {
  handle = await createTestDb();
  await handle.db.insert(schema.users).values([
    { id: USER_A, email: "a@example.test" },
    { id: USER_B, email: "b@example.test" },
  ]);
  await seedCatalog(handle.db);
});

afterAll(async () => {
  await handle.close();
});

const uuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("strength session service", () => {
  it("seeds autoload from a declared PR when no set was ever logged, without overriding measured e1RM", async () => {
    const db = handle.db;
    await db.insert(schema.personalRecords).values({
      userId: USER_A,
      kind: "weight",
      exerciseId: "back_squat",
      value: 120,
      unit: "kg",
      reps: 1,
      achievedAt: new Date("2026-09-01T10:00:00Z"),
      source: "USER",
      estimated: false,
    });
    const { workoutId } = await createStrengthWorkoutFromTemplate(db, USER_A, {
      templateId: "lower_a",
      date: TODAY,
    });
    const bundle = await getStrengthBundle(db, USER_A, workoutId);
    const squat = bundle.exercises.find((e) => e.exerciseId === "back_squat");
    expect(squat?.bestE1rmKg).toBe(120);
    expect(squat?.lastExposure).toBeNull();
    const best = await bestE1rmsByExercise(db, USER_A);
    expect(best.back_squat).toBe(120);
    // User B never declared anything.
    expect(await bestE1rmsByExercise(db, USER_B)).toEqual({});
  });

  it("applies outbox events idempotently, finishes the workout and detects an e1RM PR", async () => {
    const db = handle.db;
    const { workoutId } = await createStrengthWorkoutFromTemplate(db, USER_A, {
      templateId: "lower_a",
      date: TODAY,
    });
    const [wx] = await db
      .select()
      .from(schema.workoutExercises)
      .where(eq(schema.workoutExercises.workoutId, workoutId))
      .orderBy(schema.workoutExercises.order)
      .limit(1);
    expect(wx?.exerciseId).toBe("back_squat");
    const at = "2026-09-28T17:00:00.000Z";
    const events = [
      {
        id: uuid(1),
        workoutId,
        seq: 0,
        type: "session_started" as const,
        payload: { date: TODAY, startedAt: at },
        at,
      },
      {
        id: uuid(2),
        workoutId,
        seq: 1,
        type: "set_completed" as const,
        payload: {
          set: {
            id: uuid(3),
            workoutExerciseId: wx?.id,
            setIndex: 0,
            reps: 5,
            weightKg: 110,
            rpe: 8,
            quality: "perfect",
            completedAt: "2026-09-28T17:10:00.000Z",
            clientUpdatedAt: "2026-09-28T17:10:00.000Z",
          },
        },
        at: "2026-09-28T17:10:00.000Z",
      },
      {
        id: uuid(4),
        workoutId,
        seq: 2,
        type: "session_finished" as const,
        payload: {
          finishedAt: "2026-09-28T18:00:00.000Z",
          rpe: 8,
          feeling: "good",
          painReported: false,
          durationMin: 60,
        },
        at: "2026-09-28T18:00:00.000Z",
      },
    ];
    const first = await applyStrengthEvents(db, USER_A, events);
    expect(first.acknowledged).toEqual([uuid(1), uuid(2), uuid(4)]);
    expect(first.finishedWorkoutIds).toEqual([workoutId]);

    const replay = await applyStrengthEvents(db, USER_A, events);
    expect(replay.acknowledged).toEqual([uuid(1), uuid(2), uuid(4)]);
    expect(replay.finishedWorkoutIds).toEqual([]);

    const [w] = await db.select().from(schema.workouts).where(eq(schema.workouts.id, workoutId));
    expect(w?.status).toBe("done");
    expect(w?.sessionRpeLoad).toBe(480);
    const sets = await db
      .select()
      .from(schema.strengthSets)
      .where(eq(schema.strengthSets.workoutId, workoutId));
    expect(sets).toHaveLength(1);
    // Epley: 110 × (1 + 5/30) ≈ 128.3 kg
    expect(sets[0]?.e1rmKg).toBeCloseTo(128.3, 0);
    const analyses = await db
      .select()
      .from(schema.workoutAnalyses)
      .where(eq(schema.workoutAnalyses.workoutId, workoutId));
    expect(analyses.map((a) => a.phase).sort()).toEqual(["actual", "planned"]);
    // The measured e1RM (128.3) now beats the declared 120 kg PR seed.
    const best = await bestE1rmsByExercise(db, USER_A);
    expect(best.back_squat).toBeGreaterThan(120);
    const prs = await db
      .select()
      .from(schema.personalRecords)
      .where(eq(schema.personalRecords.userId, USER_A));
    expect(prs.some((p) => p.kind === "e1rm" && p.exerciseId === "back_squat")).toBe(true);
  });

  it("drops events for another user's workout instead of blocking the outbox", async () => {
    const db = handle.db;
    const { workoutId } = await createStrengthWorkoutFromTemplate(db, USER_A, {
      templateId: "upper_a",
      date: TODAY,
    });
    const res = await applyStrengthEvents(db, USER_B, [
      {
        id: uuid(9),
        workoutId,
        seq: 0,
        type: "set_deleted",
        payload: { setId: uuid(3) },
        at: "2026-09-28T18:00:00.000Z",
      },
    ]);
    expect(res.acknowledged).toEqual([uuid(9)]);
    const sets = await db
      .select()
      .from(schema.strengthSets)
      .where(eq(schema.strengthSets.id, uuid(3)));
    expect(sets).toHaveLength(1);
  });
});
