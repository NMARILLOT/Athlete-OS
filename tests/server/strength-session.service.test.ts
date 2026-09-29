import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { seedCatalog } from "@/db/seed";
import { createTestDb, type TestDb } from "@/db/test-db";
import {
  applyStrengthEvents,
  bestE1rmsByExercise,
  createStrengthWorkoutFromTemplate,
  getStrengthBundle,
  type OutboxEventInput,
} from "@/server/services/strength-session.service";

vi.mock("server-only", () => ({}));

const USER_A = "00000000-0000-4000-8000-0000000000a1";
const USER_B = "00000000-0000-4000-8000-0000000000b1";
const USER_C = "00000000-0000-4000-8000-0000000000c1";
const TODAY = "2026-09-28";

let handle: TestDb;

beforeAll(async () => {
  handle = await createTestDb();
  await handle.db.insert(schema.users).values([
    { id: USER_A, email: "a@example.test" },
    { id: USER_B, email: "b@example.test" },
    { id: USER_C, email: "c@example.test" },
  ]);
  await seedCatalog(handle.db);
});

afterAll(async () => {
  await handle.close();
});

const uuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** First workout_exercises row (by order) of a workout. */
async function firstExercise(workoutId: string) {
  const [wx] = await handle.db
    .select()
    .from(schema.workoutExercises)
    .where(eq(schema.workoutExercises.workoutId, workoutId))
    .orderBy(schema.workoutExercises.order)
    .limit(1);
  if (!wx) throw new Error("no exercise");
  return wx;
}

/** A full session (start → one working set → finish) as outbox events. */
function fullSession(
  workoutId: string,
  wxId: string,
  ids: [string, string, string],
  set: { reps: number; weightKg: number; setId: string },
  finish: { rpe: number | null; durationMin: number },
): OutboxEventInput[] {
  return [
    {
      id: ids[0],
      workoutId,
      seq: 0,
      type: "session_started",
      payload: { date: TODAY, startedAt: "2026-09-28T17:00:00.000Z" },
      at: "2026-09-28T17:00:00.000Z",
    },
    {
      id: ids[1],
      workoutId,
      seq: 1,
      type: "set_completed",
      payload: {
        set: {
          id: set.setId,
          workoutExerciseId: wxId,
          setIndex: 1,
          reps: set.reps,
          weightKg: set.weightKg,
          rpe: 8,
          quality: "perfect",
          completedAt: "2026-09-28T17:10:00.000Z",
          clientUpdatedAt: "2026-09-28T17:10:00.000Z",
        },
      },
      at: "2026-09-28T17:10:00.000Z",
    },
    {
      id: ids[2],
      workoutId,
      seq: 2,
      type: "session_finished",
      payload: {
        finishedAt: "2026-09-28T18:00:00.000Z",
        rpe: finish.rpe,
        feeling: "good",
        painReported: false,
        durationMin: finish.durationMin,
      },
      at: "2026-09-28T18:00:00.000Z",
    },
  ];
}

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

  it("never revives or overwrites a done workout: a later session_started / session_finished is a no-op", async () => {
    const db = handle.db;
    const { workoutId } = await createStrengthWorkoutFromTemplate(db, USER_A, {
      templateId: "lower_a",
      date: TODAY,
    });
    const wx = await firstExercise(workoutId);
    const first = await applyStrengthEvents(
      db,
      USER_A,
      fullSession(
        workoutId,
        wx.id,
        [uuid(20), uuid(21), uuid(22)],
        { reps: 5, weightKg: 100, setId: uuid(23) },
        { rpe: 8, durationMin: 60 },
      ),
    );
    expect(first.finishedWorkoutIds).toEqual([workoutId]);

    // The shell was re-seeded (back button / deep link): a fresh session with seq reset, then a
    // second "Terminer" with the default-ish values of an empty session.
    const stray = fullSession(
      workoutId,
      wx.id,
      [uuid(24), uuid(25), uuid(26)],
      { reps: 1, weightKg: 20, setId: uuid(27) },
      { rpe: 3, durationMin: 1 },
    );
    const second = await applyStrengthEvents(db, USER_A, stray);
    expect(second.acknowledged).toEqual([uuid(24), uuid(25), uuid(26)]);
    expect(second.finishedWorkoutIds).toEqual([]);

    const [w] = await db.select().from(schema.workouts).where(eq(schema.workouts.id, workoutId));
    expect(w?.status).toBe("done");
    expect(w?.rpe).toBe(8);
    expect(w?.actualDurationMin).toBe(60);
    expect(w?.sessionRpeLoad).toBe(480);
    // The stray set itself is still kept (data is never dropped), only the outcome is protected.
    const sets = await db
      .select()
      .from(schema.strengthSets)
      .where(eq(schema.strengthSets.workoutId, workoutId));
    expect(sets).toHaveLength(2);
  });

  it("exposes status, start time and the synced sets of an in-progress workout in the bundle", async () => {
    const db = handle.db;
    const { workoutId } = await createStrengthWorkoutFromTemplate(db, USER_A, {
      templateId: "lower_a",
      date: TODAY,
    });
    const wx = await firstExercise(workoutId);
    const [started, set] = fullSession(
      workoutId,
      wx.id,
      [uuid(30), uuid(31), uuid(32)],
      { reps: 6, weightKg: 90, setId: uuid(33) },
      { rpe: 7, durationMin: 45 },
    );
    await applyStrengthEvents(db, USER_A, [started as OutboxEventInput, set as OutboxEventInput]);
    const bundle = await getStrengthBundle(db, USER_A, workoutId);
    expect(bundle.status).toBe("in_progress");
    expect(bundle.startedAt).toBe("2026-09-28T17:00:00.000Z");
    expect(bundle.sets).toEqual([
      expect.objectContaining({
        id: uuid(33),
        workoutExerciseId: wx.id,
        reps: 6,
        weightKg: 90,
        rpe: 8,
        quality: "perfect",
        isWarmup: false,
      }),
    ]);
    // History for autoload still excludes this workout's own sets.
    const squat = bundle.exercises.find((e) => e.exerciseId === "back_squat");
    expect(squat?.lastExposure?.sets.some((s) => s.weightKg === 90)).toBe(false);
    // A planned workout carries no sets.
    const other = await createStrengthWorkoutFromTemplate(db, USER_A, {
      templateId: "upper_a",
      date: TODAY,
    });
    expect((await getStrengthBundle(db, USER_A, other.workoutId)).sets).toEqual([]);
  });

  it("refuses a session_started on another user's workout id (no exercises, no event row)", async () => {
    const db = handle.db;
    const { workoutId } = await createStrengthWorkoutFromTemplate(db, USER_A, {
      templateId: "upper_a",
      date: TODAY,
    });
    const res = await applyStrengthEvents(db, USER_B, [
      {
        id: uuid(40),
        workoutId,
        seq: 0,
        type: "session_started",
        payload: {
          date: TODAY,
          startedAt: "2026-09-28T10:00:00.000Z",
          exercises: [
            {
              id: uuid(41),
              exerciseId: "back_squat",
              order: 0,
              prescription: { sets: 20, repMin: 1, repMax: 1, intent: "strength" },
            },
          ],
        },
        at: "2026-09-28T10:00:00.000Z",
      },
    ]);
    expect(res.acknowledged).toEqual([uuid(40)]); // acknowledged so B's outbox never blocks
    const injected = await db
      .select()
      .from(schema.workoutExercises)
      .where(eq(schema.workoutExercises.id, uuid(41)));
    expect(injected).toHaveLength(0);
    const evRows = await db
      .select()
      .from(schema.clientEvents)
      .where(eq(schema.clientEvents.id, uuid(40)));
    expect(evRows).toHaveLength(0);
    const [w] = await db.select().from(schema.workouts).where(eq(schema.workouts.id, workoutId));
    expect(w?.status).toBe("planned");
    expect(w?.userId).toBe(USER_A);
  });

  it("does not let a set_completed upsert overwrite another user's set row", async () => {
    const db = handle.db;
    // A's set (from the first full session): uuid(3) reps 5 × 110 kg.
    const [before] = await db
      .select()
      .from(schema.strengthSets)
      .where(eq(schema.strengthSets.id, uuid(3)));
    expect(before?.userId).toBe(USER_A);
    // B owns a workout with an exercise and forges A's set id.
    const own = await createStrengthWorkoutFromTemplate(db, USER_B, {
      templateId: "lower_a",
      date: TODAY,
    });
    const wxB = await firstExercise(own.workoutId);
    const res = await applyStrengthEvents(db, USER_B, [
      {
        id: uuid(50),
        workoutId: own.workoutId,
        seq: 0,
        type: "set_completed",
        payload: {
          set: {
            id: uuid(3),
            workoutExerciseId: wxB.id,
            setIndex: 1,
            reps: 1,
            weightKg: 1,
            completedAt: "2026-09-28T19:00:00.000Z",
            clientUpdatedAt: "2026-09-28T19:00:00.000Z",
          },
        },
        at: "2026-09-28T19:00:00.000Z",
      },
    ]);
    expect(res.acknowledged).toEqual([uuid(50)]);
    const [after] = await db
      .select()
      .from(schema.strengthSets)
      .where(eq(schema.strengthSets.id, uuid(3)));
    expect(after?.userId).toBe(USER_A);
    expect(after?.reps).toBe(5);
    expect(after?.weightKg).toBe(110);
    expect(after?.e1rmKg).toBe(before?.e1rmKg);
    const bSets = await db
      .select()
      .from(schema.strengthSets)
      .where(eq(schema.strengthSets.userId, USER_B));
    expect(bSets).toHaveLength(0);
  });

  it("drops a malformed event (acknowledged + logged) instead of failing the whole batch", async () => {
    const db = handle.db;
    const { workoutId } = await createStrengthWorkoutFromTemplate(db, USER_A, {
      templateId: "upper_a",
      date: TODAY,
    });
    const wx = await firstExercise(workoutId);
    const res = await applyStrengthEvents(db, USER_A, [
      {
        id: uuid(60),
        workoutId,
        seq: 0,
        type: "session_started",
        payload: { date: "not-a-date" },
        at: "2026-09-28T10:00:00.000Z",
      },
      {
        id: uuid(61),
        workoutId,
        seq: 1,
        type: "set_completed",
        payload: {
          set: {
            id: "not-a-uuid",
            workoutExerciseId: wx.id,
            setIndex: 1,
            reps: 5,
            weightKg: 60,
            completedAt: "2026-09-28T10:05:00.000Z",
            clientUpdatedAt: "2026-09-28T10:05:00.000Z",
          },
        },
        at: "2026-09-28T10:05:00.000Z",
      },
      {
        id: uuid(62),
        workoutId,
        seq: 2,
        type: "session_finished",
        payload: { rpe: "abc", durationMin: "x", feeling: "garbage" },
        at: "2026-09-28T11:00:00.000Z",
      },
      {
        id: uuid(63),
        workoutId,
        seq: 3,
        type: "session_finished",
        payload: { finishedAt: "2026-09-28T11:00:00.000Z", rpe: 6, durationMin: 50 },
        at: "2026-09-28T11:00:00.000Z",
      },
    ]);
    // Every id is acknowledged: the three bad ones are dropped, the good finish is applied.
    expect(res.acknowledged).toEqual([uuid(60), uuid(61), uuid(62), uuid(63)]);
    expect(res.finishedWorkoutIds).toEqual([workoutId]);
    const [w] = await db.select().from(schema.workouts).where(eq(schema.workouts.id, workoutId));
    expect(w?.status).toBe("done");
    expect(w?.rpe).toBe(6);
    expect(w?.actualDurationMin).toBe(50);
    const sets = await db
      .select()
      .from(schema.strengthSets)
      .where(eq(schema.strengthSets.workoutId, workoutId));
    expect(sets).toHaveLength(0);
    const evRows = await db
      .select()
      .from(schema.clientEvents)
      .where(eq(schema.clientEvents.workoutId, workoutId));
    expect(evRows.map((e) => e.id)).toEqual([uuid(63)]);
  });

  it("does not celebrate an e1RM PR below the declared 1RM, and records the declared value as the previous PR", async () => {
    const db = handle.db;
    await db.insert(schema.personalRecords).values({
      userId: USER_C,
      kind: "weight",
      exerciseId: "back_squat",
      value: 140,
      unit: "kg",
      reps: 1,
      achievedAt: new Date("2026-09-01T10:00:00Z"),
      source: "USER",
      estimated: false,
    });
    const prsOf = async () =>
      db
        .select()
        .from(schema.personalRecords)
        .where(
          and(eq(schema.personalRecords.userId, USER_C), eq(schema.personalRecords.kind, "e1rm")),
        );

    // 100 × 5 → e1RM 116.7 < declared 140: no PR.
    const w1 = await createStrengthWorkoutFromTemplate(db, USER_C, {
      templateId: "lower_a",
      date: TODAY,
    });
    const wx1 = await firstExercise(w1.workoutId);
    await applyStrengthEvents(
      db,
      USER_C,
      fullSession(
        w1.workoutId,
        wx1.id,
        [uuid(70), uuid(71), uuid(72)],
        { reps: 5, weightKg: 100, setId: uuid(73) },
        { rpe: 7, durationMin: 50 },
      ),
    );
    expect(await prsOf()).toHaveLength(0);

    // 125 × 5 → e1RM 145.8 > 140: a PR whose baseline is the declared level.
    const w2 = await createStrengthWorkoutFromTemplate(db, USER_C, {
      templateId: "lower_a",
      date: "2026-09-30",
    });
    const wx2 = await firstExercise(w2.workoutId);
    await applyStrengthEvents(
      db,
      USER_C,
      fullSession(
        w2.workoutId,
        wx2.id,
        [uuid(74), uuid(75), uuid(76)],
        { reps: 5, weightKg: 125, setId: uuid(77) },
        { rpe: 8, durationMin: 55 },
      ),
    );
    const prs = await prsOf();
    expect(prs).toHaveLength(1);
    expect(prs[0]?.exerciseId).toBe("back_squat");
    expect(prs[0]?.value).toBeCloseTo(145.8, 0);
    expect(prs[0]?.previousValue).toBe(140);
  });
});
