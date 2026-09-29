import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { seedCatalog } from "@/db/seed";
import { createTestDb, type TestDb } from "@/db/test-db";
import { runDailyJobs } from "@/server/jobs/daily";
import { assembleEngineInput } from "@/server/services/engine-input";
import { logRestDay } from "@/server/services/log.service";
import { setFocusBlock, startDeload } from "@/server/services/profile.service";
import {
  declareIntent,
  withdrawIntents,
  withdrawStaleIntents,
} from "@/server/services/readiness.service";
import { createStrengthWorkoutFromTemplate } from "@/server/services/strength-session.service";
import { completeWorkout, moveWorkout } from "@/server/services/workout.service";

vi.mock("server-only", () => ({}));

/** Engine input assembly (ARCHITECTURE §4): what the engine sees must match what the athlete declared. */
const USER_A = "00000000-0000-4000-8000-0000000000e1";
const USER_B = "00000000-0000-4000-8000-0000000000e2";
const TZ = "Europe/Paris";

let handle: TestDb;

beforeAll(async () => {
  handle = await createTestDb();
  await handle.db.insert(schema.users).values([
    { id: USER_A, email: "engine-a@example.test" },
    { id: USER_B, email: "engine-b@example.test" },
  ]);
  await seedCatalog(handle.db);
});

afterAll(async () => {
  await handle.close();
});

const input = (userId: string, today: string) =>
  assembleEngineInput(handle.db, userId, {
    now: new Date(`${today}T07:00:00.000Z`),
    timezone: TZ,
    today,
  });

async function activeIntents(userId: string) {
  return handle.db
    .select({ startsOn: schema.userIntents.startsOn, kind: schema.userIntents.kind })
    .from(schema.userIntents)
    .where(eq(schema.userIntents.userId, userId))
    .then((rows) => rows);
}

describe("intents", () => {
  it("applies a single-day intent on its day only; a ranged intent while it straddles today", async () => {
    await declareIntent(handle.db, USER_A, { date: "2026-09-28", kind: "rest" });
    expect((await input(USER_A, "2026-09-28")).intents.map((i) => i.kind)).toEqual(["rest"]);
    expect((await input(USER_A, "2026-09-29")).intents).toEqual([]);
    expect((await input(USER_A, "2026-10-02")).intents).toEqual([]);

    await declareIntent(handle.db, USER_A, {
      date: "2026-09-27",
      kind: "no_legs",
      endsOn: "2026-10-01",
    });
    expect((await input(USER_A, "2026-09-29")).intents.map((i) => i.kind)).toEqual(["no_legs"]);
    expect((await input(USER_A, "2026-10-01")).intents.map((i) => i.kind)).toEqual(["no_legs"]);
    expect((await input(USER_A, "2026-10-02")).intents).toEqual([]);
    // Another user's intents never leak.
    expect((await input(USER_B, "2026-09-28")).intents).toEqual([]);
  });

  it("withdraws stale single-day intents (daily job and 'Effacer'), keeps ranged ones", async () => {
    expect(await withdrawStaleIntents(handle.db, USER_A, "2026-09-29")).toBe(1);
    const rows = await handle.db
      .select()
      .from(schema.userIntents)
      .where(eq(schema.userIntents.userId, USER_A));
    expect(rows.find((r) => r.kind === "rest")?.status).toBe("withdrawn");
    expect(rows.find((r) => r.kind === "no_legs")?.status).toBe("active");

    await declareIntent(handle.db, USER_A, { date: "2026-09-28", kind: "lazy" });
    await runDailyJobs(handle.db, new Date("2026-09-29T04:00:00.000Z"));
    const afterCron = await handle.db
      .select()
      .from(schema.userIntents)
      .where(eq(schema.userIntents.userId, USER_A));
    expect(afterCron.find((r) => r.kind === "lazy")?.status).toBe("withdrawn");

    await declareIntent(handle.db, USER_A, { date: "2026-09-29", kind: "want_run" });
    await withdrawIntents(handle.db, USER_A, "2026-09-30");
    const afterClear = await activeIntents(USER_A);
    expect(afterClear.length).toBeGreaterThan(0);
    const cleared = await handle.db
      .select()
      .from(schema.userIntents)
      .where(eq(schema.userIntents.userId, USER_A));
    expect(cleared.find((r) => r.kind === "want_run")?.status).toBe("withdrawn");
  });
});

describe("planned set", () => {
  it("keeps a user-moved (auto_adjusted) workout in the engine's planned sessions", async () => {
    const { workoutId } = await createStrengthWorkoutFromTemplate(handle.db, USER_A, {
      templateId: "lower_a",
      date: "2026-10-01",
    });
    expect((await input(USER_A, "2026-10-01")).planned.map((p) => p.id)).toContain(workoutId);
    await moveWorkout(handle.db, USER_A, workoutId, "2026-10-02", TZ);
    const [row] = await handle.db
      .select()
      .from(schema.workouts)
      .where(eq(schema.workouts.id, workoutId));
    expect(row?.status).toBe("auto_adjusted");
    const planned = (await input(USER_A, "2026-10-01")).planned.find((p) => p.id === workoutId);
    expect(planned).toMatchObject({ date: "2026-10-02", status: "planned", fixed: false });
  });
});

describe("history", () => {
  it("gives a logged rest day a zero load vector and no estimate", async () => {
    await logRestDay(handle.db, USER_A, { date: "2026-09-26" });
    const rest = (await input(USER_A, "2026-09-27")).history.find((s) => s.type === "rest");
    expect(rest).toBeDefined();
    expect(rest?.loadVector).toEqual({
      cardiovascular: 0,
      muscular_lower: 0,
      muscular_upper: 0,
      impact: 0,
      eccentric: 0,
      technical: 0,
    });
    expect(rest?.expectedCredits).toEqual({});
    expect(rest?.estimated).toBe(false);
    expect(rest?.impactUnits).toBe(0);
    expect(rest?.intensity).toBe("easy");
  });

  it("ends a late-feedback session at its planned end, not at the feedback time", async () => {
    const [w] = await handle.db
      .insert(schema.workouts)
      .values({
        userId: USER_A,
        type: "strength",
        source: "planned_user",
        status: "planned",
        date: "2026-09-25",
        startAt: new Date("2026-09-25T05:00:00.000Z"),
        plannedDurationMin: 60,
        title: "Strength — Upper",
        plannedIntensity: "moderate",
        expectedRpe: 7,
      })
      .returning();
    if (!w) throw new Error("insert failed");
    await completeWorkout(handle.db, USER_A, {
      workoutId: w.id,
      rpe: 8,
      feeling: "good",
      painReported: false,
      now: new Date("2026-09-27T07:00:00.000Z"),
      timezone: TZ,
    });
    const [done] = await handle.db
      .select()
      .from(schema.workouts)
      .where(eq(schema.workouts.id, w.id));
    expect(done?.finishedAt?.toISOString()).toBe("2026-09-25T06:00:00.000Z");
    const session = (await input(USER_A, "2026-09-27")).history.find((s) => s.id === w.id);
    expect(session?.endTime).toBe("2026-09-25T06:00:00.000Z");
  });

  it("ignores a stored finish time that falls on a later day than the session (legacy rows)", async () => {
    const [w] = await handle.db
      .insert(schema.workouts)
      .values({
        userId: USER_A,
        type: "cardio",
        source: "manual",
        status: "done",
        date: "2026-09-24",
        startAt: new Date("2026-09-24T06:00:00.000Z"),
        plannedDurationMin: 45,
        actualDurationMin: 45,
        title: "Run — Easy",
        realisedIntensity: "easy",
        rpe: 4,
        finishedAt: new Date("2026-09-27T09:00:00.000Z"),
      })
      .returning();
    if (!w) throw new Error("insert failed");
    const session = (await input(USER_A, "2026-09-27")).history.find((s) => s.id === w.id);
    expect(session?.endTime).toBe("2026-09-24T06:45:00.000Z");
  });
});

describe("training blocks", () => {
  it("keeps the deload active when a focus block starts later", async () => {
    await startDeload(handle.db, USER_B, { today: "2026-09-27", days: 7 });
    const during = await input(USER_B, "2026-09-29");
    expect(during.deload).toMatchObject({ active: true, until: "2026-10-03" });
    const deloadTargets = during.profile.targets;

    await setFocusBlock(handle.db, USER_B, { focus: "build", today: "2026-09-29" });
    const after = await input(USER_B, "2026-09-29");
    expect(after.deload).toMatchObject({ active: true, until: "2026-10-03" });
    // The focus block shapes the targets, the deload still scales them down.
    expect(after.profile.targets.hi_conditioning).toBeLessThanOrEqual(
      deloadTargets.hi_conditioning ?? Infinity,
    );
    expect((await input(USER_B, "2026-10-04")).deload).toBeNull();
  });
});
