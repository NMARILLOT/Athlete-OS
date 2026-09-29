import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { seedCatalog } from "@/db/seed";
import { createTestDb, type TestDb } from "@/db/test-db";
import {
  completeOnboarding,
  DEFAULT_GOAL_WEIGHTS,
  deleteUserData,
  endDeload,
  exportUserData,
  getProfileView,
  seedDeclaredPrs,
  setAvailability,
  setFocusBlock,
  setGoalWeights,
  setMediumGoals,
  startDeload,
  updateIdentity,
  upsertPreferences,
  upsertProfileBasics,
} from "@/server/services/profile.service";

vi.mock("server-only", () => ({}));

const USER_A = "00000000-0000-4000-8000-0000000000a7";
const USER_B = "00000000-0000-4000-8000-0000000000b7";
const TODAY = "2026-09-28";
const A = { id: USER_A, timezone: "Europe/Paris" };
const B = { id: USER_B, timezone: "Europe/Paris" };

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

describe("profile service — view defaults", () => {
  it("shows the engine defaults when nothing is stored, never invented values", async () => {
    const view = await getProfileView(handle.db, A, { today: TODAY });
    expect(view.user.id).toBe(USER_A);
    expect(view.user.onboardingCompletedAt).toBeNull();
    expect(view.goals.usingDefaults).toBe(true);
    expect(Object.fromEntries(view.goals.long.map((g) => [g.key, g.weight]))).toEqual(
      DEFAULT_GOAL_WEIGHTS,
    );
    expect(view.goals.medium.every((g) => !g.active)).toBe(true);
    expect(view.profile.weeklyHoursTarget).toBe(7);
    expect(view.profile.stored).toBe(false);
    expect(view.profile.lthrManual).toBeNull();
    expect(view.profile.baselinePhase).toBe(true); // onboarding not done yet
    expect(view.preferences.maxHardSessionsPerWeek).toBe(3);
    expect(view.preferences.stored).toBe(false);
    expect(view.block).toBeNull();
    expect(view.deload).toBeNull();
    expect(view.pains).toEqual([]);
    expect(view.availability).toEqual([]);
    expect(view.declaredPrs).toEqual([]);
    expect(view.integrations.garmin.provider).toBe("mock");
    expect(view.integrations.garmin.status).toBeNull();
    expect(typeof view.flags.garmin).toBe("boolean");
    expect(view.today).toBe(TODAY);
  });
});

describe("profile service — goals", () => {
  it("materialises the six long-term goals on first write and updates in place afterwards", async () => {
    const db = handle.db;
    await setGoalWeights(db, USER_A, { strength: 1, physique: 0.3 });
    let rows = await db
      .select()
      .from(schema.goals)
      .where(and(eq(schema.goals.userId, USER_A), eq(schema.goals.horizon, "long")));
    expect(rows).toHaveLength(6);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey.strength?.weight).toBe(1);
    expect(byKey.physique?.weight).toBe(0.3);
    expect(byKey.health_longevity?.weight).toBe(DEFAULT_GOAL_WEIGHTS.health_longevity);
    expect(byKey.strength?.title).toBe("Force");

    await setGoalWeights(db, USER_A, { endurance: 0.5 });
    rows = await db
      .select()
      .from(schema.goals)
      .where(and(eq(schema.goals.userId, USER_A), eq(schema.goals.horizon, "long")));
    expect(rows).toHaveLength(6); // idempotent: no duplicate rows
    expect(rows.find((r) => r.key === "endurance")?.weight).toBe(0.5);
    expect(rows.find((r) => r.key === "strength")?.weight).toBe(1); // untouched

    const view = await getProfileView(db, A, { today: TODAY });
    expect(view.goals.usingDefaults).toBe(false);
    expect(view.goals.long.find((g) => g.key === "endurance")?.weight).toBe(0.5);
  });

  it("rejects a medium-term key on the long-term editor and clamps weights to 0..1", async () => {
    await expect(setGoalWeights(handle.db, USER_A, { event_5k: 1 })).rejects.toThrow();
    await setGoalWeights(handle.db, USER_A, { fun: 4 });
    const view = await getProfileView(handle.db, A, { today: TODAY });
    expect(view.goals.long.find((g) => g.key === "fun")?.weight).toBe(1);
  });

  it("switches medium-term goals on/off without deleting rows and seeds long goals first", async () => {
    const db = handle.db;
    // User B has no goal at all: the medium editor must create the long rows too.
    await setMediumGoals(db, USER_B, ["event_5k", "lift_clean"]);
    const longB = await db
      .select()
      .from(schema.goals)
      .where(and(eq(schema.goals.userId, USER_B), eq(schema.goals.horizon, "long")));
    expect(longB).toHaveLength(6);
    let view = await getProfileView(db, B, { today: TODAY });
    expect(view.goals.medium.filter((g) => g.active).map((g) => g.key)).toEqual([
      "event_5k",
      "lift_clean",
    ]);
    expect(view.goals.medium.find((g) => g.key === "event_5k")?.weight).toBe(0.7);

    await setMediumGoals(db, USER_B, ["lift_clean"], { lift_clean: 0.9 });
    view = await getProfileView(db, B, { today: TODAY });
    expect(view.goals.medium.filter((g) => g.active).map((g) => g.key)).toEqual(["lift_clean"]);
    expect(view.goals.medium.find((g) => g.key === "lift_clean")?.weight).toBe(0.9);
    const mediumRows = await db
      .select()
      .from(schema.goals)
      .where(and(eq(schema.goals.userId, USER_B), eq(schema.goals.horizon, "medium")));
    expect(mediumRows).toHaveLength(2); // deactivated, not deleted
    expect(mediumRows.find((r) => r.key === "event_5k")?.active).toBe(false);

    // User A's goals are not affected by B's writes.
    const viewA = await getProfileView(db, A, { today: TODAY });
    expect(viewA.goals.medium.every((g) => !g.active)).toBe(true);
  });
});

describe("profile service — profile basics & preferences", () => {
  it("upserts partial changes without wiping other fields", async () => {
    const db = handle.db;
    await upsertProfileBasics(db, USER_A, {
      equipment: ["barbell", "rower", "barbell"],
      facilities: { crossfitBox: true, gym: false, home: true },
      preferredTrainingTimes: { crossfit: "18:30" },
    });
    await upsertProfileBasics(db, USER_A, { lthrManual: 172, weeklyHoursTarget: 9 });
    const view = await getProfileView(db, A, { today: TODAY });
    expect(view.profile.stored).toBe(true);
    expect(view.profile.equipment).toEqual(["barbell", "rower"]);
    expect(view.profile.facilities).toEqual({ crossfitBox: true, gym: false, home: true });
    expect(view.profile.preferredTrainingTimes).toEqual({ crossfit: "18:30" });
    expect(view.profile.lthrManual).toBe(172);
    expect(view.profile.maxHrManual).toBeNull();
    expect(view.profile.weeklyHoursTarget).toBe(9);
    const rows = await db
      .select()
      .from(schema.athleteProfiles)
      .where(eq(schema.athleteProfiles.userId, USER_A));
    expect(rows).toHaveLength(1);
  });

  it("stores preferences and validates increments", async () => {
    const db = handle.db;
    await upsertPreferences(db, USER_A, {
      barbellIncrementKg: 2.5,
      maxHardSessionsPerWeek: 2,
      favouriteModalities: ["running", "weightlifting"],
    });
    await upsertPreferences(db, USER_A, { dislikedModalities: ["swimming"] });
    const view = await getProfileView(db, A, { today: TODAY });
    expect(view.preferences.stored).toBe(true);
    expect(view.preferences.maxHardSessionsPerWeek).toBe(2);
    expect(view.preferences.favouriteModalities).toEqual(["running", "weightlifting"]);
    expect(view.preferences.dislikedModalities).toEqual(["swimming"]);
    await expect(upsertPreferences(db, USER_A, { barbellIncrementKg: 0 })).rejects.toThrow();
  });

  it("updates identity and refuses an invalid timezone", async () => {
    await updateIdentity(handle.db, USER_A, { displayName: "  Nico ", timezone: "Europe/Paris" });
    const view = await getProfileView(handle.db, A, { today: TODAY });
    expect(view.user.displayName).toBe("Nico");
    await expect(
      updateIdentity(handle.db, USER_A, { timezone: "Mars/Olympus_Mons" }),
    ).rejects.toThrow();
  });
});

describe("profile service — availability", () => {
  it("replaces the recurring USER windows and leaves dated windows alone", async () => {
    const db = handle.db;
    await db.insert(schema.availabilityWindows).values({
      userId: USER_A,
      weekday: null,
      date: "2026-10-03",
      startMinute: 600,
      endMinute: 720,
      kind: "busy",
      source: "USER",
    });
    await setAvailability(db, USER_A, [
      { weekday: 0, startMinute: 360, endMinute: 540 },
      { weekday: 2, startMinute: 1050, endMinute: 1260 },
      { weekday: 2, startMinute: 1050, endMinute: 1260 }, // duplicate ignored
      { weekday: 5, startMinute: 690, endMinute: 840 },
    ]);
    let view = await getProfileView(db, A, { today: TODAY });
    expect(view.availability.map((s) => `${s.weekday}:${s.startMinute}`)).toEqual([
      "0:360",
      "2:1050",
      "5:690",
    ]);
    await setAvailability(db, USER_A, [{ weekday: 6, startMinute: 360, endMinute: 540 }]);
    view = await getProfileView(db, A, { today: TODAY });
    expect(view.availability).toHaveLength(1);
    expect(view.availability[0]?.weekday).toBe(6);
    const all = await db
      .select()
      .from(schema.availabilityWindows)
      .where(eq(schema.availabilityWindows.userId, USER_A));
    expect(all).toHaveLength(2); // recurring + the dated busy window
    await expect(
      setAvailability(db, USER_A, [{ weekday: 7, startMinute: 0, endMinute: 60 }]),
    ).rejects.toThrow();
    await expect(
      setAvailability(db, USER_A, [{ weekday: 1, startMinute: 600, endMinute: 600 }]),
    ).rejects.toThrow();
  });
});

describe("profile service — declared PRs", () => {
  it("writes declared 1RM as USER weight records, ignores unknown lifts, updates in place", async () => {
    const db = handle.db;
    const written = await seedDeclaredPrs(db, USER_A, [
      { exerciseId: "back_squat", weightKg: 140 },
      { exerciseId: "clean", weightKg: 100.3 },
      { exerciseId: "not_a_lift", weightKg: 50 },
      { exerciseId: "deadlift", weightKg: 0 },
    ]);
    expect(written).toEqual(["back_squat", "clean"]);
    let rows = await db
      .select()
      .from(schema.personalRecords)
      .where(eq(schema.personalRecords.userId, USER_A));
    expect(rows).toHaveLength(2);
    const squat = rows.find((r) => r.exerciseId === "back_squat");
    expect(squat).toMatchObject({
      kind: "weight",
      unit: "kg",
      reps: 1,
      value: 140,
      source: "USER",
      estimated: false,
    });
    expect(rows.find((r) => r.exerciseId === "clean")?.value).toBe(100.25);

    await seedDeclaredPrs(db, USER_A, [{ exerciseId: "back_squat", weightKg: 145 }]);
    rows = await db
      .select()
      .from(schema.personalRecords)
      .where(eq(schema.personalRecords.userId, USER_A));
    expect(rows).toHaveLength(2); // no duplicate on the natural key
    const updated = rows.find((r) => r.exerciseId === "back_squat");
    expect(updated?.value).toBe(145);
    expect(updated?.previousValue).toBe(140);

    const view = await getProfileView(db, A, { today: TODAY });
    expect(view.declaredPrs.map((p) => [p.exerciseId, p.valueKg])).toEqual([
      ["back_squat", 145],
      ["clean", 100.25],
    ]);
    expect(view.declaredPrs[0]?.name).toBe("Back squat");
  });
});

describe("profile service — onboarding completion", () => {
  it("sets the completion date and a 21-day baseline phase, idempotently", async () => {
    const db = handle.db;
    await completeOnboarding(db, USER_B, TODAY);
    let view = await getProfileView(db, B, { today: TODAY });
    expect(view.user.onboardingCompletedAt).not.toBeNull();
    expect(view.profile.baselinePhaseUntil).toBe("2026-10-19");
    expect(view.profile.baselinePhase).toBe(true);
    const first = view.user.onboardingCompletedAt;

    await completeOnboarding(db, USER_B, "2026-11-01");
    view = await getProfileView(db, B, { today: "2026-11-01" });
    expect(view.user.onboardingCompletedAt).toBe(first);
    expect(view.profile.baselinePhaseUntil).toBe("2026-10-19");
    expect(view.profile.baselinePhase).toBe(false);
  });
});

describe("profile service — focus blocks & deload", () => {
  it("opens a focus block, replaces it on change and keeps it during a deload", async () => {
    const db = handle.db;
    const base = await setFocusBlock(db, USER_A, { focus: "base", today: TODAY });
    expect(base.name).toBe("Base aérobie + force");
    let view = await getProfileView(db, A, { today: TODAY });
    expect(view.block?.focus).toBe("base");
    expect(view.deload).toBeNull();

    const deload = await startDeload(db, USER_A, {
      today: TODAY,
      days: 7,
      reason: "Fatigue accumulée",
    });
    expect(deload.endsOn).toBe("2026-10-04");
    const again = await startDeload(db, USER_A, { today: TODAY });
    expect(again.id).toBe(deload.id); // idempotent while active
    view = await getProfileView(db, A, { today: TODAY });
    expect(view.deload?.reason).toBe("Fatigue accumulée");
    expect(view.block?.id).toBe(base.id); // focus block untouched by the deload

    const build = await setFocusBlock(db, USER_A, {
      focus: "build",
      name: "Bloc seuil",
      today: TODAY,
    });
    view = await getProfileView(db, A, { today: TODAY });
    expect(view.block?.id).toBe(build.id);
    expect(view.block?.name).toBe("Bloc seuil");
    const [old] = await db
      .select()
      .from(schema.trainingBlocks)
      .where(eq(schema.trainingBlocks.id, base.id));
    expect(old?.endedBy).toBe("USER");

    expect(await endDeload(db, USER_A, TODAY)).toBe(true);
    expect(await endDeload(db, USER_A, TODAY)).toBe(false);
    view = await getProfileView(db, A, { today: TODAY });
    expect(view.deload).toBeNull();
    const [ended] = await db
      .select()
      .from(schema.trainingBlocks)
      .where(eq(schema.trainingBlocks.id, deload.id));
    expect(ended?.endedBy).toBe("USER");
    expect(ended?.source).toBe("USER");

    await expect(
      setFocusBlock(db, USER_A, { focus: "recovery" as never, today: TODAY }),
    ).rejects.toThrow();
    await expect(startDeload(db, USER_A, { today: TODAY, days: 40 })).rejects.toThrow();
  });

  it("does not show another user's block or pains", async () => {
    const db = handle.db;
    await db.insert(schema.painLogs).values({
      userId: USER_A,
      location: "knee",
      side: "left",
      intensity: 4,
      status: "active",
    });
    const viewB = await getProfileView(db, B, { today: TODAY });
    expect(viewB.block).toBeNull();
    expect(viewB.pains).toEqual([]);
    const viewA = await getProfileView(db, A, { today: TODAY });
    expect(viewA.pains.map((p) => p.location)).toEqual(["knee"]);
  });
});

describe("profile service — privacy", () => {
  it("exports every user-owned table as plain JSON without secrets", async () => {
    const db = handle.db;
    await db.insert(schema.workouts).values({
      userId: USER_A,
      type: "strength",
      source: "planned_user",
      date: TODAY,
      title: "Lower A",
    });
    await db.insert(schema.integrations).values({
      userId: USER_A,
      provider: "garmin",
      status: "connected",
      credentialsEncrypted: Buffer.from("top-secret"),
    });
    const out = await exportUserData(db, USER_A);
    expect(out.format).toBe("athlete-os-export-v1");
    expect(out.user.id).toBe(USER_A);
    expect(out.tables.workouts).toHaveLength(1);
    expect(out.tables.goals?.length).toBeGreaterThanOrEqual(6);
    expect(out.tables.personal_records).toHaveLength(2);
    expect(out.tables.pain_logs).toHaveLength(1);
    expect(out.tables.training_blocks).toHaveLength(3);
    expect(out.tables.availability_windows).toHaveLength(2);
    expect(out.tables.integrations).toHaveLength(1);
    const integ = out.tables.integrations?.[0] as Record<string, unknown>;
    expect(integ).not.toHaveProperty("credentialsEncrypted");
    expect(integ.status).toBe("connected");
    expect(JSON.stringify(out)).not.toContain("top-secret");
    // Dates are ISO strings, everything round-trips through JSON unchanged.
    const w = out.tables.workouts?.[0] as Record<string, unknown>;
    expect(typeof w.createdAt).toBe("string");
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
    for (const name of [
      "athlete_profiles",
      "user_preferences",
      "workout_exercises",
      "strength_sets",
      "cardio_workouts",
      "crossfit_workouts",
      "coach_sessions",
      "workout_analyses",
      "activities",
      "activity_laps",
      "activity_streams",
      "raw_payloads",
      "daily_readiness",
      "recovery_metrics",
      "body_compositions",
      "benchmark_results",
      "test_results",
      "recommendations",
      "user_intents",
      "computed_metrics",
      "hr_zone_sets",
      "events",
      "travel_periods",
      "wod_inbox_items",
      "ai_invocations",
    ]) {
      expect(Array.isArray(out.tables[name])).toBe(true);
    }
    // Only user A's rows.
    const outB = await exportUserData(db, USER_B);
    expect(outB.tables.workouts).toHaveLength(0);
    expect(outB.tables.integrations).toHaveLength(0);
  });

  it("deletes the account and everything it owns, leaving the other user intact", async () => {
    const db = handle.db;
    await db.insert(schema.workouts).values({
      userId: USER_B,
      type: "cardio",
      source: "planned_user",
      date: TODAY,
      title: "Run easy",
    });
    await seedDeclaredPrs(db, USER_B, [{ exerciseId: "deadlift", weightKg: 180 }]);

    await deleteUserData(db, USER_A);

    const usersLeft = await db.select().from(schema.users);
    expect(usersLeft.map((u) => u.id)).toEqual([USER_B]);
    for (const table of [
      schema.workouts,
      schema.goals,
      schema.personalRecords,
      schema.painLogs,
      schema.trainingBlocks,
      schema.availabilityWindows,
      schema.athleteProfiles,
      schema.userPreferences,
      schema.integrations,
    ]) {
      const rowsA = await db.select().from(table).where(eq(table.userId, USER_A));
      expect(rowsA).toHaveLength(0);
    }
    const workoutsB = await db
      .select()
      .from(schema.workouts)
      .where(eq(schema.workouts.userId, USER_B));
    expect(workoutsB).toHaveLength(1);
    const prsB = await db
      .select()
      .from(schema.personalRecords)
      .where(eq(schema.personalRecords.userId, USER_B));
    expect(prsB).toHaveLength(1);
    const goalsB = await db.select().from(schema.goals).where(eq(schema.goals.userId, USER_B));
    expect(goalsB.length).toBeGreaterThanOrEqual(6);
    // The catalog is global and survives.
    const exercises = await db.select().from(schema.exercises);
    expect(exercises.length).toBeGreaterThan(50);
  });
});
