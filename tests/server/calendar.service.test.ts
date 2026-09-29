import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { seedCatalog } from "@/db/seed";
import { createTestDb, type TestDb } from "@/db/test-db";
import { checkPlacement } from "@/domain/engine";
import type * as EngineModule from "@/domain/engine";
import type { CurrentUser } from "@/server/auth/types";
import { NotFoundError, ValidationError } from "@/server/errors";
import {
  checkMove,
  getCalendarWeek,
  moveWorkoutChecked,
  planRestDay,
  typeOfFamily,
} from "@/server/services/calendar.service";
import { getCurrentRecommendation } from "@/server/services/recommendation.service";
import { logQuickWorkout } from "@/server/services/workout.service";

vi.mock("server-only", () => ({}));
// Wrap checkPlacement so the tests can assert whether the engine was consulted.
vi.mock("@/domain/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof EngineModule>();
  return { ...actual, checkPlacement: vi.fn(actual.checkPlacement) };
});

/**
 * Calendar service on PGlite (spec §53): outlook merging with real workouts, past weeks without
 * projections, move verification (fixed classes blocked without the engine, engine veto refused
 * unless forced), ownership isolation and the idempotent rest-day quick action.
 */
const USER_A: CurrentUser = {
  id: "00000000-0000-4000-8000-0000000000ca",
  email: "ca@example.test",
  timezone: "Europe/Paris",
  displayName: "A",
  onboardingCompletedAt: null,
};
const USER_B: CurrentUser = {
  ...USER_A,
  id: "00000000-0000-4000-8000-0000000000cb",
  email: "cb@example.test",
};
const NOW = new Date("2026-09-28T07:30:00.000Z"); // Monday 09:30 Paris
const TODAY = "2026-09-28";
const WEEK = "2026-09-28";
const PAST_WEEK = "2026-09-21";

let handle: TestDb;
let wedRunId: string;
let friStrengthId: string;

async function insertWorkout(
  values: Partial<typeof schema.workouts.$inferInsert> & {
    userId: string;
    date: string;
    type: typeof schema.workouts.$inferInsert.type;
    title: string;
  },
): Promise<string> {
  const [row] = await handle.db
    .insert(schema.workouts)
    .values({ source: "planned_user", status: "planned", ...values })
    .returning({ id: schema.workouts.id });
  if (!row) throw new Error("insert returned no row");
  return row.id;
}

async function workoutRow(id: string) {
  const [w] = await handle.db.select().from(schema.workouts).where(eq(schema.workouts.id, id));
  if (!w) throw new Error("missing workout");
  return w;
}

beforeAll(async () => {
  handle = await createTestDb();
  await handle.db.insert(schema.users).values([
    { id: USER_A.id, email: USER_A.email },
    { id: USER_B.id, email: USER_B.email },
  ]);
  await seedCatalog(handle.db);
  wedRunId = await insertWorkout({
    userId: USER_A.id,
    date: "2026-09-30",
    type: "cardio",
    title: "Run facile 45",
    startAt: new Date("2026-09-30T06:00:00.000Z"), // 08:00 Paris
    plannedDurationMin: 45,
    plannedIntensity: "easy",
  });
  friStrengthId = await insertWorkout({
    userId: USER_A.id,
    date: "2026-10-02",
    type: "strength",
    title: "Strength — Lower",
    plannedDurationMin: 60,
    plannedIntensity: "moderate",
  });
});

afterAll(async () => {
  await handle.close();
});

describe("getCalendarWeek", () => {
  it("builds the current week from real workouts and today's outlook", async () => {
    const week = await getCalendarWeek(handle.db, USER_A, "2026-09-30", NOW);
    expect(week.weekStart).toBe(WEEK);
    expect(week.today).toBe(TODAY);
    expect(week.weekOutlookDate).toBe(TODAY);
    expect(week.days).toHaveLength(7);
    expect(week.days.map((d) => d.date)).toEqual([
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ]);
    expect(week.days[0]?.isToday).toBe(true);
    expect(week.days.filter((d) => d.isPast)).toHaveLength(0);

    const wed = week.days[2];
    expect(wed?.workouts.map((w) => w.id)).toEqual([wedRunId]);
    expect(wed?.workouts[0]).toMatchObject({
      type: "cardio",
      kind: "run_easy_45",
      family: "run_easy",
      startMinute: 8 * 60,
      durationMin: 45,
      status: "planned",
      fixed: false,
    });
    if (wed?.outlook) expect(typeOfFamily(wed.outlook.family)).not.toBe("cardio");

    const fri = week.days[4];
    expect(fri?.workouts.map((w) => w.id)).toEqual([friStrengthId]);
    expect(fri?.workouts[0]?.kind).toBe("strength_lower");
    if (fri?.outlook) expect(typeOfFamily(fri.outlook.family)).not.toBe("strength");

    // An empty future day always carries the projected primary and its explanation.
    const tue = week.days[1];
    expect(tue?.workouts).toEqual([]);
    expect(tue?.outlook).not.toBeNull();
    expect(tue?.outlook?.title).toBeTruthy();
    expect(tue?.outlookExplanation).toBeTruthy();
    expect(["HIGH", "MEDIUM", "LOW"]).toContain(tue?.outlookConfidence);

    expect(week.summary).toMatchObject({ planned: 2, done: 0, skipped: 0, doneMinutes: 0 });
    expect(week.summary.engineDate).toBe(TODAY);
    expect(week.summary.hard).not.toBeNull();
    expect(week.summary.hard?.max).toBeGreaterThanOrEqual(week.summary.hard?.done ?? 0);
    for (const g of week.summary.topGaps) expect(g.label).toBeTruthy();
  });

  it("a real planned session suppresses the projected session of the same family", async () => {
    const rec = await getCurrentRecommendation(handle.db, USER_A.id, TODAY);
    const thursday = rec?.output.weekOutlook?.find((d) => d.date === "2026-10-01");
    if (!thursday) throw new Error("missing outlook for Thursday");
    const before = await getCalendarWeek(handle.db, USER_A, WEEK, NOW);
    expect(before.days[3]?.outlook?.kind).toBe(thursday.primary.kind);

    const projectedType = typeOfFamily(thursday.primary.family);
    await insertWorkout({
      userId: USER_A.id,
      date: "2026-10-01",
      type: projectedType === "rest" ? "mobility" : projectedType,
      title: thursday.primary.title,
      plannedDurationMin: thursday.primary.durationMin,
    });
    const after = await getCalendarWeek(handle.db, USER_A, WEEK, NOW);
    expect(after.days[3]?.workouts).toHaveLength(1);
    expect(after.days[3]?.outlook).toBeNull();
    expect(after.summary.planned).toBe(3);
  });

  it("past weeks carry real workouts only", async () => {
    await insertWorkout({
      userId: USER_A.id,
      date: "2026-09-23",
      type: "cardio",
      title: "Run facile",
      status: "done",
      source: "manual",
      plannedDurationMin: 50,
      actualDurationMin: 45,
    });
    await insertWorkout({
      userId: USER_A.id,
      date: "2026-09-24",
      type: "strength",
      title: "Strength — Upper",
      status: "skipped",
    });
    const week = await getCalendarWeek(handle.db, USER_A, PAST_WEEK, NOW);
    expect(week.weekStart).toBe(PAST_WEEK);
    expect(week.weekOutlookDate).toBeNull();
    expect(week.days.every((d) => d.isPast && !d.isToday)).toBe(true);
    expect(week.days.every((d) => d.outlook === null && d.bonus === null)).toBe(true);
    expect(week.days.every((d) => d.outlookExplanation === null)).toBe(true);
    expect(week.days[2]?.workouts[0]?.status).toBe("done");
    expect(week.summary).toEqual({
      planned: 0,
      done: 1,
      skipped: 1,
      doneMinutes: 45,
      hard: null,
      topGaps: [],
      deloadActive: false,
      engineDate: null,
    });
  });
});

describe("checkMove / moveWorkoutChecked", () => {
  it("blocks a fixed class without consulting the engine", async () => {
    const fixedId = await insertWorkout({
      userId: USER_A.id,
      date: "2026-09-29",
      type: "crossfit",
      title: "CrossFit — Fran",
      source: "wod_inbox",
      fixed: true,
      plannedDurationMin: 60,
      plannedIntensity: "hard",
    });
    vi.mocked(checkPlacement).mockClear();
    const check = await checkMove(handle.db, USER_A, fixedId, "2026-09-30", NOW);
    expect(check.movable).toBe(false);
    expect(check.verdict.verdict).toBe("veto");
    expect(check.verdict.outcomes[0]?.ruleId).toBe("FIXED_SESSION");
    expect(check.verdict.summary).toMatch(/fixée/);
    expect(check.fromDate).toBe("2026-09-29");
    expect(check.workoutTitle).toBe("CrossFit — Fran");
    expect(checkPlacement).not.toHaveBeenCalled();

    await expect(
      moveWorkoutChecked(handle.db, USER_A, fixedId, "2026-09-30", { force: true, now: NOW }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await workoutRow(fixedId)).date).toBe("2026-09-29");
  });

  it("blocks moves into the past and no-ops on the same day, otherwise asks the engine", async () => {
    vi.mocked(checkPlacement).mockClear();
    const past = await checkMove(handle.db, USER_A, friStrengthId, "2026-09-27", NOW);
    expect(past.movable).toBe(false);
    expect(past.verdict.outcomes[0]?.ruleId).toBe("PAST_DATE");
    const same = await checkMove(handle.db, USER_A, friStrengthId, "2026-10-02", NOW);
    expect(same.movable).toBe(true);
    expect(same.verdict.verdict).toBe("ok");
    expect(checkPlacement).not.toHaveBeenCalled();

    const check = await checkMove(handle.db, USER_A, friStrengthId, "2026-10-03", NOW);
    expect(checkPlacement).toHaveBeenCalledTimes(1);
    expect(check.movable).toBe(true);
    expect(check.fromDate).toBe("2026-10-02");
    expect(check.toDate).toBe("2026-10-03");
    expect(check.verdict.date).toBe("2026-10-03");
    expect(["ok", "warn", "veto"]).toContain(check.verdict.verdict);
    expect(check.verdict.summary).toContain("2026-10-03");
    // The moved workout is taken out of its current slot before the engine projects the week.
    const input = vi.mocked(checkPlacement).mock.calls[0]?.[0];
    expect(input?.planned.some((p) => p.id === friStrengthId)).toBe(false);
    const session = vi.mocked(checkPlacement).mock.calls[0]?.[1];
    expect(session).toMatchObject({ kind: "strength_lower", family: "strength_lower" });
  });

  it("refuses an engine veto without force and moves with force", async () => {
    for (const date of ["2026-09-25", "2026-09-26", "2026-09-27"]) {
      await logQuickWorkout(handle.db, USER_A.id, {
        date,
        type: "cardio",
        title: "Run VO2",
        durationMin: 40,
        rpe: 9,
        feeling: "good",
        intensity: "hard",
        kind: "run_vo2",
        timezone: USER_A.timezone,
      });
    }
    const hardId = await insertWorkout({
      userId: USER_A.id,
      date: "2026-09-29",
      type: "cardio",
      title: "Run VO2max",
      plannedDurationMin: 40,
      plannedIntensity: "hard",
    });
    const check = await checkMove(handle.db, USER_A, hardId, "2026-10-01", NOW);
    expect(check.movable).toBe(true);
    expect(check.verdict.verdict).toBe("veto");
    expect(check.verdict.outcomes.some((o) => o.effect === "veto")).toBe(true);
    expect(check.verdict.summary).toMatch(/Mauvaise idée/);

    await expect(
      moveWorkoutChecked(handle.db, USER_A, hardId, "2026-10-01", { now: NOW }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await workoutRow(hardId)).date).toBe("2026-09-29");

    const forced = await moveWorkoutChecked(handle.db, USER_A, hardId, "2026-10-01", {
      force: true,
      now: NOW,
    });
    expect(forced.verdict.verdict).toBe("veto");
    const moved = await workoutRow(hardId);
    expect(moved.date).toBe("2026-10-01");
    expect(moved.status).toBe("auto_adjusted");
    const week = await getCalendarWeek(handle.db, USER_A, WEEK, NOW);
    expect(week.days[3]?.workouts.map((w) => w.id)).toContain(hardId);
    expect(week.days[1]?.workouts.map((w) => w.id)).not.toContain(hardId);
  });

  it("never reaches another user's workouts", async () => {
    const otherId = await insertWorkout({
      userId: USER_B.id,
      date: "2026-09-30",
      type: "cardio",
      title: "Run B",
    });
    await expect(checkMove(handle.db, USER_A, otherId, "2026-10-01", NOW)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      moveWorkoutChecked(handle.db, USER_A, otherId, "2026-10-01", { force: true, now: NOW }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await workoutRow(otherId)).date).toBe("2026-09-30");

    const weekA = await getCalendarWeek(handle.db, USER_A, WEEK, NOW);
    const idsA = weekA.days.flatMap((d) => d.workouts.map((w) => w.id));
    expect(idsA).not.toContain(otherId);
    const weekB = await getCalendarWeek(handle.db, USER_B, WEEK, NOW);
    const idsB = weekB.days.flatMap((d) => d.workouts.map((w) => w.id));
    expect(idsB).toEqual([otherId]);
    expect(weekB.summary.planned).toBe(1);
  });
});

describe("planRestDay", () => {
  it("creates one planned rest row per date and never counts it as a session", async () => {
    const before = await getCalendarWeek(handle.db, USER_A, WEEK, NOW);
    expect(before.days[6]?.workouts).toEqual([]);
    const first = await planRestDay(handle.db, USER_A.id, "2026-10-04");
    const again = await planRestDay(handle.db, USER_A.id, "2026-10-04");
    expect(first.created).toBe(true);
    expect(again).toEqual({ id: first.id, created: false });
    const rows = await handle.db
      .select()
      .from(schema.workouts)
      .where(eq(schema.workouts.id, first.id));
    expect(rows[0]).toMatchObject({
      userId: USER_A.id,
      type: "rest",
      source: "manual",
      status: "planned",
      date: "2026-10-04",
      title: "Repos",
    });
    const after = await getCalendarWeek(handle.db, USER_A, WEEK, NOW);
    const sunday = after.days[6];
    expect(sunday?.workouts.map((w) => w.type)).toEqual(["rest"]);
    expect(sunday?.workouts[0]?.status).toBe("planned");
    // Rest is not a session: the planned count is unchanged and a projected rest is covered.
    expect(after.summary.planned).toBe(before.summary.planned);
    if (sunday?.outlook) expect(sunday.outlook.family).not.toBe("rest");
  });
});
