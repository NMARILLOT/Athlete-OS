import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "@/db/test-db";
import {
  COACH_SESSION_ALGORITHM_VERSION,
  COACH_SESSION_LOAD,
  coachSessionLoadVector,
  listActivePains,
  listRecentBodyCompositions,
  logBodyComposition,
  logCoachSession,
  logRestDay,
} from "@/server/services/log.service";
import { logPain, resolvePain } from "@/server/services/readiness.service";

const USER_A = "00000000-0000-4000-8000-0000000000a1";
const USER_B = "00000000-0000-4000-8000-0000000000b1";
const TZ = "Europe/Paris";

let handle: TestDb;

beforeAll(async () => {
  handle = await createTestDb();
  await handle.db.insert(schema.users).values([
    { id: USER_A, email: "log-a@example.test", displayName: "A" },
    { id: USER_B, email: "log-b@example.test", displayName: "B" },
  ]);
});

afterAll(async () => {
  await handle.close();
});

describe("logCoachSession", () => {
  it("creates a done coach_session workout, its coach_sessions row and an ACTUAL analysis", async () => {
    const { id } = await logCoachSession(handle.db, USER_A, {
      date: "2026-09-28",
      startMinute: 18 * 60,
      durationMin: 90,
      demoLevel: "heavy",
      standingMinutes: 150,
      perceivedFatigue: 4,
      timezone: TZ,
    });
    const [w] = await handle.db.select().from(schema.workouts).where(eq(schema.workouts.id, id));
    expect(w).toMatchObject({
      userId: USER_A,
      type: "coach_session",
      source: "manual",
      status: "done",
      title: "Coaching CrossFit",
      fixed: true,
      actualDurationMin: 90,
      plannedIntensity: "moderate",
      // Perceived fatigue is the coach's context, not the athlete's RPE: no declared RPE, no AU.
      rpe: null,
      sessionRpeLoad: null,
    });
    expect(w?.startAt?.toISOString()).toBe("2026-09-28T16:00:00.000Z");
    // Finished at the declared start + duration, not at the log time.
    expect(w?.finishedAt?.toISOString()).toBe("2026-09-28T17:30:00.000Z");
    const [cs] = await handle.db
      .select()
      .from(schema.coachSessions)
      .where(eq(schema.coachSessions.workoutId, id));
    expect(cs).toMatchObject({ demoLevel: "heavy", standingMinutes: 150, perceivedFatigue: 4 });
    const analyses = await handle.db
      .select()
      .from(schema.workoutAnalyses)
      .where(eq(schema.workoutAnalyses.workoutId, id));
    expect(analyses).toHaveLength(1);
    const a = analyses[0];
    expect(a).toMatchObject({
      phase: "actual",
      source: "CALCULATED",
      algorithmVersion: COACH_SESSION_ALGORITHM_VERSION,
      confidence: "MEDIUM",
      stimulusCredits: {},
      heavyStrength: false,
    });
    expect(a?.loadVector).toEqual({
      cardiovascular: 3,
      muscular_lower: 3.5,
      muscular_upper: 3,
      impact: 1,
      eccentric: 0,
      technical: 0,
    });
  });

  it("maps demo level to a small, monotonic load", () => {
    const none = coachSessionLoadVector("none", 30);
    const heavy = coachSessionLoadVector("heavy", 30);
    expect(none.cardiovascular).toBeLessThan(heavy.cardiovascular);
    expect(none.muscular_lower).toBeLessThan(heavy.muscular_lower);
    expect(heavy.cardiovascular).toBeLessThanOrEqual(3);
    expect(heavy.impact).toBeLessThanOrEqual(1);
    expect(COACH_SESSION_LOAD.none.intensity).toBe("easy");
    expect(COACH_SESSION_LOAD.heavy.intensity).toBe("moderate");
    // Standing bonus only applies to the legs, from two hours on the floor.
    expect(coachSessionLoadVector("light", 119).muscular_lower).toBe(1.5);
    expect(coachSessionLoadVector("light", 120).muscular_lower).toBe(2);
  });

  it("stores a null start when no time is given", async () => {
    const { id } = await logCoachSession(handle.db, USER_A, {
      date: "2026-09-29",
      startMinute: null,
      durationMin: 60,
      demoLevel: "none",
      standingMinutes: 60,
      perceivedFatigue: 1,
      timezone: TZ,
    });
    const [w] = await handle.db.select().from(schema.workouts).where(eq(schema.workouts.id, id));
    expect(w?.startAt).toBeNull();
    expect(w?.rpe).toBeNull();
    expect(w?.sessionRpeLoad).toBeNull();
  });
});

describe("logRestDay", () => {
  it("is idempotent per (user, date) and isolated between users", async () => {
    const first = await logRestDay(handle.db, USER_A, { date: "2026-10-01" });
    const second = await logRestDay(handle.db, USER_A, { date: "2026-10-01" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    const other = await logRestDay(handle.db, USER_B, { date: "2026-10-01" });
    expect(other.created).toBe(true);
    expect(other.id).not.toBe(first.id);
    const rows = await handle.db
      .select()
      .from(schema.workouts)
      .where(and(eq(schema.workouts.type, "rest"), eq(schema.workouts.date, "2026-10-01")));
    expect(rows).toHaveLength(2);
    const mine = rows.find((r) => r.userId === USER_A);
    expect(mine).toMatchObject({ source: "manual", status: "done", title: "Repos" });
    const analyses = await handle.db
      .select()
      .from(schema.workoutAnalyses)
      .where(eq(schema.workoutAnalyses.workoutId, first.id));
    expect(analyses).toHaveLength(0);
  });
});

describe("logBodyComposition", () => {
  it("stores a MANUAL reading and denormalises the LATEST weight on the profile", async () => {
    await logBodyComposition(handle.db, USER_A, {
      measuredAt: new Date("2026-09-20T06:30:00Z"),
      weightKg: 80.4,
      bodyFatPct: 15.2,
      timezone: TZ,
    });
    await logBodyComposition(handle.db, USER_A, {
      measuredAt: new Date("2026-09-27T06:30:00Z"),
      weightKg: 79.8,
      muscleMassKg: 62.1,
      waterPct: 58,
      timezone: TZ,
    });
    // A back-dated entry never overrides a newer reading.
    await logBodyComposition(handle.db, USER_A, {
      measuredAt: new Date("2026-09-10T06:30:00Z"),
      weightKg: 81.5,
      timezone: TZ,
    });
    const [profile] = await handle.db
      .select()
      .from(schema.athleteProfiles)
      .where(eq(schema.athleteProfiles.userId, USER_A));
    expect(profile?.bodyweightKg).toBe(79.8);

    const list = await listRecentBodyCompositions(handle.db, USER_A, 8);
    expect(list.map((r) => r.weightKg)).toEqual([79.8, 80.4, 81.5]);
    expect(list[0]).toMatchObject({
      source: "MANUAL",
      localDate: "2026-09-27",
      muscleMassKg: 62.1,
      waterPct: 58,
      bodyFatPct: null,
    });
    expect(await listRecentBodyCompositions(handle.db, USER_A, 2)).toHaveLength(2);
    expect(await listRecentBodyCompositions(handle.db, USER_B)).toEqual([]);
  });

  it("upserts a reading logged twice on the same minute", async () => {
    const at = new Date("2026-09-28T07:00:00Z");
    const a = await logBodyComposition(handle.db, USER_A, {
      measuredAt: at,
      weightKg: 79.5,
      timezone: TZ,
    });
    const b = await logBodyComposition(handle.db, USER_A, {
      measuredAt: at,
      weightKg: 79.6,
      timezone: TZ,
    });
    expect(b.id).toBe(a.id);
    const rows = await handle.db
      .select()
      .from(schema.bodyCompositions)
      .where(
        and(eq(schema.bodyCompositions.userId, USER_A), eq(schema.bodyCompositions.measuredAt, at)),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.weightKg).toBe(79.6);
    const [profile] = await handle.db
      .select()
      .from(schema.athleteProfiles)
      .where(eq(schema.athleteProfiles.userId, USER_A));
    expect(profile?.bodyweightKg).toBe(79.6);
  });
});

describe("listActivePains", () => {
  it("lists active pains newest first and drops resolved ones", async () => {
    const knee = await logPain(handle.db, USER_A, {
      location: "knee",
      side: "left",
      intensity: 4,
      movementSpecific: true,
      movements: ["back_squat"],
      sudden: false,
      persistent: false,
    });
    const shoulder = await logPain(handle.db, USER_A, {
      location: "shoulder",
      intensity: 8,
      movementSpecific: false,
      movements: [],
      sudden: true,
      persistent: true,
    });
    expect(knee.medicalAdvice).toBe(false);
    expect(shoulder.medicalAdvice).toBe(true);
    await logPain(handle.db, USER_B, {
      location: "hip",
      intensity: 2,
      movementSpecific: false,
      movements: [],
      sudden: false,
      persistent: false,
    });
    const active = await listActivePains(handle.db, USER_A);
    expect(active.map((p) => p.location)).toEqual(["shoulder", "knee"]);
    expect(active[1]).toMatchObject({ side: "left", movements: ["back_squat"], status: "active" });
    await resolvePain(handle.db, USER_A, knee.id);
    expect((await listActivePains(handle.db, USER_A)).map((p) => p.id)).toEqual([shoulder.id]);
    expect((await listActivePains(handle.db, USER_B)).map((p) => p.location)).toEqual(["hip"]);
  });
});
