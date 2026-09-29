import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import * as schema from "@/db/schema";
import { seedCatalog } from "@/db/seed";
import { createTestDb, type TestDb } from "@/db/test-db";
import { emptyLoadVector, FEELING_TO_FUN } from "@/domain/core";
import { addDays, isoWeekStart } from "@/domain/core/dates";
import {
  distributionBucketOf,
  formatBenchmarkScore,
  getProgressView,
  hrBandOf,
} from "@/server/services/progress.service";

const USER_A = "00000000-0000-4000-8000-0000000000a7";
const USER_B = "00000000-0000-4000-8000-0000000000b7";
/** A Monday, so "this ISO week" is unambiguous in the heatmap assertions. */
const TODAY = "2026-09-28";
const TZ = "Europe/Paris";

let handle: TestDb;

type WorkoutInsert = typeof schema.workouts.$inferInsert;

async function insertDone(values: Partial<WorkoutInsert> & { date: string; userId?: string }) {
  const [row] = await handle.db
    .insert(schema.workouts)
    .values({
      userId: USER_A,
      type: "strength",
      source: "planned_user",
      status: "done",
      title: "Séance",
      ...values,
    })
    .returning();
  if (!row) throw new Error("insert returned no row");
  return row;
}

async function insertActual(
  workoutId: string,
  date: string,
  patternExposure: Record<string, number>,
  muscleExposure: Record<string, number>,
  userId = USER_A,
) {
  await handle.db.insert(schema.workoutAnalyses).values({
    userId,
    workoutId,
    phase: "actual",
    date,
    stimulusCredits: {},
    loadVector: emptyLoadVector(),
    patternExposure,
    muscleExposure,
    energySystems: [],
    impactUnits: 0,
    intensity: "moderate",
    heavyStrength: false,
    source: "CALCULATED",
    algorithmVersion: "test_v1",
    confidence: "HIGH",
  });
}

beforeAll(async () => {
  handle = await createTestDb();
  await handle.db.insert(schema.users).values([
    { id: USER_A, email: "progress-a@example.test", displayName: "A" },
    { id: USER_B, email: "progress-b@example.test", displayName: "B" },
  ]);
  await seedCatalog(handle.db);

  // --- User A: four weeks of done workouts (loads span 26 days → ratio available) ---------
  const d = (offset: number) => addDays(TODAY, offset);
  // Strength, this week (today), heavy: 60 min, RPE 8, stored load 480, feeling good.
  const squatDay = await insertDone({
    date: TODAY,
    type: "strength",
    actualDurationMin: 60,
    rpe: 8,
    sessionRpeLoad: 480,
    feeling: "good",
    realisedIntensity: "moderate",
  });
  await insertActual(squatDay.id, TODAY, { squat: 6, hinge: 2 }, { quads: 8, glutes: 6 });
  // CrossFit last week: 60 min planned only, RPE 9 → load fallback 540, feeling great.
  await insertDone({
    date: d(-3),
    type: "crossfit",
    plannedDurationMin: 60,
    rpe: 9,
    feeling: "great",
    realisedIntensity: "hard",
  });
  // Easy run last week (cardio easy): 45 min, RPE 4, feeling meh.
  await insertDone({
    date: d(-5),
    type: "cardio",
    actualDurationMin: 45,
    rpe: 4,
    feeling: "meh",
    realisedIntensity: "easy",
  });
  // Hard intervals (cardio, no band, RPE 8 → hard): 40 min.
  await insertDone({ date: d(-12), type: "cardio", actualDurationMin: 40, rpe: 8 });
  // Easy free walk → recovery: 50 min, RPE 3.
  await insertDone({
    date: d(-13),
    type: "free",
    title: "Marche en forêt",
    actualDurationMin: 50,
    rpe: 3,
    realisedIntensity: "easy",
  });
  // Mobility → recovery: 20 min, no RPE → no load.
  await insertDone({ date: d(-19), type: "mobility", actualDurationMin: 20 });
  // Old strength session, 25 days ago: 50 min, RPE 7 → 350.
  const oldSquat = await insertDone({
    date: d(-25),
    type: "strength",
    actualDurationMin: 50,
    rpe: 7,
    sessionRpeLoad: 350,
    feeling: "too_hard",
  });
  // Planned (not done) workout must never count.
  await insertDone({ date: d(-1), type: "crossfit", status: "planned", plannedDurationMin: 60 });

  // Strength sets: back squat this week (best 122.5) and 25 days ago (best 110); a warm-up and
  // a null-e1RM set that must be ignored; a non-benchmark lift that must not create a series.
  const [wxNow] = await handle.db
    .insert(schema.workoutExercises)
    .values({
      userId: USER_A,
      workoutId: squatDay.id,
      date: TODAY,
      order: 0,
      exerciseId: "back_squat",
      prescription: {
        sets: 3,
        repMin: 5,
        repMax: 5,
        targetRpeMin: 7,
        targetRpeMax: 8.5,
        intent: "strength",
        loadSuggestionKg: null,
        restSec: null,
      },
    })
    .returning();
  const [wxOld] = await handle.db
    .insert(schema.workoutExercises)
    .values({
      userId: USER_A,
      workoutId: oldSquat.id,
      date: d(-25),
      order: 0,
      exerciseId: "back_squat",
      prescription: {
        sets: 3,
        repMin: 5,
        repMax: 5,
        targetRpeMin: 7,
        targetRpeMax: 8.5,
        intent: "strength",
        loadSuggestionKg: null,
        restSec: null,
      },
    })
    .returning();
  if (!wxNow || !wxOld) throw new Error("workout_exercises insert failed");
  const set = (
    wx: typeof wxNow,
    date: string,
    setIndex: number,
    reps: number,
    weightKg: number,
    e1rmKg: number | null,
    isWarmup = false,
    exerciseId = "back_squat",
  ) => ({
    userId: USER_A,
    workoutId: wx.workoutId,
    workoutExerciseId: wx.id,
    exerciseId,
    date,
    setIndex,
    reps,
    weightKg,
    e1rmKg,
    isWarmup,
    completedAt: new Date(`${date}T16:${String(10 + setIndex).padStart(2, "0")}:00Z`),
  });
  await handle.db
    .insert(schema.strengthSets)
    .values([
      set(wxNow, TODAY, 0, 5, 60, 70, true),
      set(wxNow, TODAY, 1, 5, 100, 116.5),
      set(wxNow, TODAY, 2, 5, 105, 122.5),
      set(wxNow, TODAY, 3, 5, 105, null),
      set(wxNow, TODAY, 4, 10, 30, 40, false, "biceps_curl"),
      set(wxOld, d(-25), 0, 5, 95, 110),
    ]);

  // Personal records: a current estimated e1RM PR, a superseded one, a benchmark PR (no exercise).
  await handle.db.insert(schema.personalRecords).values([
    {
      userId: USER_A,
      kind: "e1rm",
      exerciseId: "back_squat",
      value: 122.5,
      unit: "kg",
      reps: 5,
      achievedAt: new Date(`${TODAY}T16:12:00Z`),
      workoutId: squatDay.id,
      source: "CALCULATED",
      estimated: true,
      algorithmVersion: "e1rm_epley_v1",
    },
    {
      userId: USER_A,
      kind: "e1rm",
      exerciseId: "back_squat",
      value: 110,
      unit: "kg",
      reps: 5,
      achievedAt: new Date(`${d(-25)}T16:10:00Z`),
      workoutId: oldSquat.id,
      source: "CALCULATED",
      estimated: true,
      algorithmVersion: "e1rm_epley_v1",
      superseded: true,
    },
    {
      userId: USER_A,
      kind: "benchmark",
      benchmarkId: "fran",
      value: 305,
      unit: "s",
      achievedAt: new Date(`${d(-3)}T18:00:00Z`),
      source: "USER",
    },
  ]);
  await handle.db.insert(schema.benchmarkResults).values({
    userId: USER_A,
    benchmarkId: "fran",
    date: d(-3),
    scoreValue: 305,
    scoreKind: "time",
    rx: true,
  });
  await handle.db.insert(schema.testResults).values({
    userId: USER_A,
    testKey: "run_5k",
    date: d(-20),
    value: 1500,
    unit: "s",
    source: "USER",
  });
  await handle.db.insert(schema.computedMetrics).values([
    {
      userId: USER_A,
      metric: "threshold_pace_sec_km",
      scope: "day",
      date: d(-10),
      value: 300,
      unit: "sec/km",
      algorithmVersion: "threshold_v1",
    },
    {
      userId: USER_A,
      metric: "threshold_pace_sec_km",
      scope: "day",
      date: d(-11),
      value: 310,
      unit: "sec/km",
      algorithmVersion: "threshold_v0",
      superseded: true,
    },
  ]);
  const [flatRun] = await handle.db
    .insert(schema.activities)
    .values([
      {
        userId: USER_A,
        provider: "fit_import",
        fingerprint: "running|1",
        sport: "running",
        startAt: new Date(`${d(-5)}T07:00:00Z`),
        localDate: d(-5),
        durationSec: 2700,
        distanceM: 8000,
        avgHr: 143,
        avgPaceSecKm: 337.5,
        parserVersion: "fit_v1",
        comparableGroup: "easy_run_flat_45_75min",
      },
      {
        userId: USER_A,
        provider: "fit_import",
        fingerprint: "running|2",
        sport: "running",
        startAt: new Date(`${d(-12)}T07:00:00Z`),
        localDate: d(-12),
        durationSec: 2400,
        distanceM: 8000,
        avgHr: 171,
        avgPaceSecKm: 300,
        parserVersion: "fit_v1",
        comparableGroup: "hard_run_flat_under45min",
      },
      // A hilly long run: another easy_run group, never merged with the flat 45–75 min one (§30).
      {
        userId: USER_A,
        provider: "fit_import",
        fingerprint: "running|3",
        sport: "running",
        startAt: new Date(`${d(-8)}T08:00:00Z`),
        localDate: d(-8),
        durationSec: 5400,
        distanceM: 14000,
        avgHr: 147,
        avgPaceSecKm: 385,
        parserVersion: "fit_v1",
        comparableGroup: "easy_run_hilly_75_120min",
      },
      // No comparable group (unknown conditions) → not "comparable", not plotted.
      {
        userId: USER_A,
        provider: "fit_import",
        fingerprint: "running|4",
        sport: "running",
        startAt: new Date(`${d(-9)}T08:00:00Z`),
        localDate: d(-9),
        durationSec: 3000,
        distanceM: 9000,
        avgHr: 144,
        avgPaceSecKm: 333,
        parserVersion: "fit_v1",
        comparableGroup: null,
      },
    ])
    .returning({ id: schema.activities.id });
  if (!flatRun) throw new Error("activities insert failed");
  // The versioned pace @ HR metric exists for the flat run: preferred over the activity average.
  await handle.db.insert(schema.computedMetrics).values([
    {
      userId: USER_A,
      metric: "pace_at_hr",
      scope: "activity",
      scopeId: flatRun.id,
      date: d(-5),
      value: 330,
      unit: "s/km",
      algorithmVersion: "pace_at_hr_v1",
      inputs: { zone: 2, hrMin: 145, hrMax: 152, avgHr: 148.2, sampleCount: 400 },
    },
    {
      userId: USER_A,
      metric: "pace_at_hr",
      scope: "activity",
      scopeId: flatRun.id,
      date: d(-5),
      value: 999,
      unit: "s/km",
      algorithmVersion: "pace_at_hr_v0",
      inputs: {},
      superseded: true,
    },
  ]);
  await handle.db.insert(schema.recoveryMetrics).values([
    { userId: USER_A, date: TODAY, metric: "resting_hr", value: 48, unit: "bpm", source: "GARMIN" },
    { userId: USER_A, date: TODAY, metric: "hrv_rmssd", value: 62, unit: "ms", source: "GARMIN" },
    { userId: USER_A, date: TODAY, metric: "sleep_hours", value: 7.4, unit: "h", source: "GARMIN" },
    { userId: USER_A, date: d(-1), metric: "resting_hr", value: 50, unit: "bpm", source: "MANUAL" },
    { userId: USER_A, date: d(-1), metric: "resting_hr", value: 49, unit: "bpm", source: "GARMIN" },
  ]);

  // --- User B: one recent done workout only (thin history → no ratio), must stay invisible to A.
  const b = await insertDone({
    userId: USER_B,
    date: TODAY,
    type: "strength",
    actualDurationMin: 90,
    rpe: 9,
    sessionRpeLoad: 810,
    feeling: "great",
  });
  await insertActual(b.id, TODAY, { gymnastics: 9 }, { lats: 9 }, USER_B);
  const [wxB] = await handle.db
    .insert(schema.workoutExercises)
    .values({
      userId: USER_B,
      workoutId: b.id,
      date: TODAY,
      order: 0,
      exerciseId: "back_squat",
      prescription: {
        sets: 3,
        repMin: 5,
        repMax: 5,
        targetRpeMin: 7,
        targetRpeMax: 8.5,
        intent: "strength",
        loadSuggestionKg: null,
        restSec: null,
      },
    })
    .returning();
  if (!wxB) throw new Error("workout_exercises insert failed");
  await handle.db.insert(schema.strengthSets).values({
    userId: USER_B,
    workoutId: b.id,
    workoutExerciseId: wxB.id,
    exerciseId: "back_squat",
    date: TODAY,
    setIndex: 0,
    reps: 3,
    weightKg: 180,
    e1rmKg: 198,
    completedAt: new Date(`${TODAY}T10:00:00Z`),
  });
  await handle.db.insert(schema.recoveryMetrics).values({
    userId: USER_B,
    date: TODAY,
    metric: "resting_hr",
    value: 40,
    unit: "bpm",
    source: "GARMIN",
  });
});

afterAll(async () => {
  await handle.close();
});

describe("distributionBucketOf", () => {
  const base = {
    date: TODAY,
    title: "x",
    plannedDurationMin: null,
    actualDurationMin: 30,
    plannedIntensity: null,
    realisedIntensity: null,
    rpe: null,
    feeling: null,
    sessionRpeLoad: null,
  } as const;
  it("maps every workout type to one of the five buckets", () => {
    expect(distributionBucketOf({ ...base, type: "crossfit" })).toBe("crossfit");
    expect(distributionBucketOf({ ...base, type: "strength" })).toBe("strength");
    expect(distributionBucketOf({ ...base, type: "mobility" })).toBe("recovery");
    expect(distributionBucketOf({ ...base, type: "rest" })).toBe("recovery");
    expect(distributionBucketOf({ ...base, type: "coach_session" })).toBe("recovery");
    expect(distributionBucketOf({ ...base, type: "cardio", realisedIntensity: "easy" })).toBe(
      "easyEndurance",
    );
    expect(distributionBucketOf({ ...base, type: "cardio", plannedIntensity: "moderate" })).toBe(
      "hardEndurance",
    );
    expect(distributionBucketOf({ ...base, type: "free", rpe: 8 })).toBe("hardEndurance");
    expect(distributionBucketOf({ ...base, type: "free", rpe: 3 })).toBe("easyEndurance");
    expect(distributionBucketOf({ ...base, type: "free", title: "Walk 45", rpe: 3 })).toBe(
      "recovery",
    );
    // Unknown intensity is never promoted to "hard".
    expect(distributionBucketOf({ ...base, type: "cardio" })).toBe("easyEndurance");
  });
});

describe("formatting helpers", () => {
  it("formats benchmark scores per score kind", () => {
    expect(formatBenchmarkScore("time", 305)).toBe("5:05");
    expect(formatBenchmarkScore("load", 100)).toBe("100 kg");
    expect(formatBenchmarkScore("reps", 42)).toBe("42 reps");
    expect(formatBenchmarkScore("rounds_reps", 12)).toBe("12 rounds");
    expect(formatBenchmarkScore("rounds_reps", 12.07)).toBe("12 rounds + 7 reps");
  });
  it("buckets average HR by 10 bpm", () => {
    expect(hrBandOf(143)).toBe("140–149");
    expect(hrBandOf(150)).toBe("150–159");
  });
});

describe("getProgressView", () => {
  it("bounds the range and fills dense weeks", async () => {
    const view = await getProgressView(handle.db, USER_A, "4w", TODAY, { timezone: TZ });
    expect(view.range).toBe("4w");
    expect(view.from).toBe(addDays(TODAY, -27));
    expect(view.to).toBe(TODAY);
    // 27 days back from a Monday → 5 ISO weeks touched, one row each, zeros included.
    expect(view.volume).toHaveLength(5);
    expect(view.volume.map((w) => w.weekStart)).toEqual(view.distribution.map((w) => w.weekStart));
    expect(view.volume[0]?.weekStart).toBe(isoWeekStart(view.from));
  });

  it("sums minutes per ISO week of done workouts only", async () => {
    const view = await getProgressView(handle.db, USER_A, "4w", TODAY, { timezone: TZ });
    const byWeek = new Map(view.volume.map((w) => [w.weekStart, w.minutes]));
    expect(byWeek.get(TODAY)).toBe(60); // this week: the squat session (the planned one is ignored)
    expect(byWeek.get(addDays(TODAY, -7))).toBe(105); // crossfit 60 (planned duration) + easy run 45
    expect(byWeek.get(addDays(TODAY, -14))).toBe(90); // intervals 40 + walk 50
    expect(byWeek.get(addDays(TODAY, -21))).toBe(20); // mobility
    expect(byWeek.get(addDays(TODAY, -28))).toBe(50); // old strength (25 days ago is in that week)
  });

  it("splits the distribution into the five buckets", async () => {
    const view = await getProgressView(handle.db, USER_A, "4w", TODAY, { timezone: TZ });
    const byWeek = new Map(view.distribution.map((w) => [w.weekStart, w]));
    expect(byWeek.get(TODAY)).toMatchObject({ strength: 60, crossfit: 0 });
    expect(byWeek.get(addDays(TODAY, -7))).toMatchObject({ crossfit: 60, easyEndurance: 45 });
    expect(byWeek.get(addDays(TODAY, -14))).toMatchObject({ hardEndurance: 40, recovery: 50 });
    expect(byWeek.get(addDays(TODAY, -21))).toMatchObject({ recovery: 20 });
  });

  it("builds a weekly best e1RM series per benchmark lift, working sets only", async () => {
    const view = await getProgressView(handle.db, USER_A, "4w", TODAY, { timezone: TZ });
    expect(view.strength).toHaveLength(1);
    const squat = view.strength[0];
    expect(squat?.exerciseId).toBe("back_squat");
    expect(squat?.name).toBe("Back squat");
    expect(squat?.points).toEqual([
      { date: addDays(TODAY, -28), e1rmKg: 110 },
      { date: TODAY, e1rmKg: 122.5 },
    ]);
  });

  it("computes session-RPE load with the duration × RPE fallback and a ratio on enough history", async () => {
    const view = await getProgressView(handle.db, USER_A, "4w", TODAY, { timezone: TZ });
    expect(view.load.daily).toHaveLength(28);
    const byDate = new Map(view.load.daily.map((d) => [d.date, d.load]));
    expect(byDate.get(TODAY)).toBe(480);
    expect(byDate.get(addDays(TODAY, -3))).toBe(540); // 60 min × RPE 9, no stored load
    expect(byDate.get(addDays(TODAY, -5))).toBe(180);
    expect(byDate.get(addDays(TODAY, -19))).toBe(0); // mobility without RPE → unknown → 0
    expect(view.load.acute7d).toBe(480 + 540 + 180);
    // 28-day total: 480 + 540 + 180 + 320 + 150 + 350 = 2020 → weekly mean 505.
    expect(view.load.chronicWeeklyAvg).toBe(505);
    expect(view.load.ratio).toBe(Math.round((1200 / 505) * 100) / 100);
  });

  it("keeps the load window at 28 days whatever the displayed range", async () => {
    const view = await getProgressView(handle.db, USER_A, "7d", TODAY, { timezone: TZ });
    expect(view.load.daily).toHaveLength(7);
    expect(view.load.acute7d).toBe(1200);
    expect(view.load.chronicWeeklyAvg).toBe(505);
    expect(view.load.ratio).not.toBeNull();
    expect(view.volume).toHaveLength(2);
  });

  it("never invents a ratio on thin history", async () => {
    const view = await getProgressView(handle.db, USER_B, "4w", TODAY, { timezone: TZ });
    expect(view.load.acute7d).toBe(810);
    expect(view.load.chronicWeeklyAvg).toBe(Math.round(810 / 4));
    expect(view.load.ratio).toBeNull();
  });

  it("maps declared feelings to the documented fun score per day", async () => {
    const view = await getProgressView(handle.db, USER_A, "4w", TODAY, { timezone: TZ });
    expect(view.enjoyment).toEqual([
      { date: addDays(TODAY, -25), fun: FEELING_TO_FUN.too_hard },
      { date: addDays(TODAY, -5), fun: FEELING_TO_FUN.meh },
      { date: addDays(TODAY, -3), fun: FEELING_TO_FUN.great },
      { date: TODAY, fun: FEELING_TO_FUN.good },
    ]);
  });

  it("fills the aerobic engine from comparable easy runs, threshold metrics and tests", async () => {
    const view = await getProgressView(handle.db, USER_A, "4w", TODAY, { timezone: TZ });
    // One series per comparable group, never merged; the hard run and the group-less run are out.
    expect(view.engine.paceAtHr).toEqual([
      {
        comparableGroup: "easy_run_flat_45_75min",
        points: [
          // Current `pace_at_hr` metric preferred (the superseded v0 row is ignored).
          { date: addDays(TODAY, -5), paceSecKm: 330, hrBand: "145–152", basis: "pace_at_hr" },
        ],
      },
      {
        comparableGroup: "easy_run_hilly_75_120min",
        points: [
          {
            date: addDays(TODAY, -8),
            paceSecKm: 385,
            hrBand: "140–149",
            basis: "activity_average",
          },
        ],
      },
    ]);
    // Current computed metric + the 5 km test converted with the documented factor (300 × 1.05).
    expect(view.engine.thresholdPace).toEqual([
      { date: addDays(TODAY, -20), paceSecKm: 315 },
      { date: addDays(TODAY, -10), paceSecKm: 300 },
    ]);
    expect(view.engine.tests).toEqual([
      { date: addDays(TODAY, -20), testKey: "run_5k", value: 1500, unit: "s" },
    ]);
  });

  it("lists benchmarks with a formatted score and current PRs with the estimated flag", async () => {
    const view = await getProgressView(handle.db, USER_A, "4w", TODAY, { timezone: TZ });
    expect(view.crossfit.benchmarks).toEqual([
      { benchmarkId: "fran", name: "Fran", date: addDays(TODAY, -3), score: "5:05 Rx" },
    ]);
    expect(view.crossfit.prs).toEqual([
      {
        exerciseId: "back_squat",
        name: "Back squat",
        value: 122.5,
        unit: "kg",
        date: TODAY,
        estimated: true,
      },
    ]);
  });

  it("pivots recovery metrics per day, preferring measured sources", async () => {
    const view = await getProgressView(handle.db, USER_A, "4w", TODAY, { timezone: TZ });
    expect(view.recovery).toEqual([
      { date: addDays(TODAY, -1), restingHr: 49, hrv: null, sleepHours: null, bodyBattery: null },
      { date: TODAY, restingHr: 48, hrv: 62, sleepHours: 7.4, bodyBattery: null },
    ]);
  });

  it("builds this week's heatmap from actual analyses", async () => {
    const view = await getProgressView(handle.db, USER_A, "4w", TODAY, { timezone: TZ });
    const squat = view.heatmap.patterns.find((p) => p.key === "squat");
    expect(squat).toEqual({ key: "squat", value: 6, bars: 4 });
    expect(view.heatmap.patterns.find((p) => p.key === "gymnastics")?.value).toBe(0);
    expect(view.heatmap.muscles.find((m) => m.key === "quads")).toEqual({
      key: "quads",
      value: 8,
      bars: 4,
    });
  });

  it("isolates users: B's sets, metrics and analyses never leak into A's view and vice versa", async () => {
    const a = await getProgressView(handle.db, USER_A, "4w", TODAY, { timezone: TZ });
    const b = await getProgressView(handle.db, USER_B, "4w", TODAY, { timezone: TZ });
    expect(a.strength[0]?.points.some((p) => p.e1rmKg === 198)).toBe(false);
    expect(a.recovery.find((r) => r.date === TODAY)?.restingHr).toBe(48);
    expect(b.recovery).toEqual([
      { date: TODAY, restingHr: 40, hrv: null, sleepHours: null, bodyBattery: null },
    ]);
    expect(b.strength).toEqual([
      { exerciseId: "back_squat", name: "Back squat", points: [{ date: TODAY, e1rmKg: 198 }] },
    ]);
    expect(b.heatmap.patterns.find((p) => p.key === "squat")?.value).toBe(0);
    expect(b.crossfit.benchmarks).toEqual([]);
    expect(b.engine.tests).toEqual([]);
  });

  it("resolves the `all` range from the earliest stored day and returns empties for a blank user", async () => {
    const all = await getProgressView(handle.db, USER_A, "all", TODAY, { timezone: TZ });
    expect(all.from).toBe(addDays(TODAY, -25));
    expect(all.volume.length).toBeGreaterThanOrEqual(4);

    const NOBODY = "00000000-0000-4000-8000-0000000000c7";
    await handle.db.insert(schema.users).values({ id: NOBODY, email: "nobody@example.test" });
    const empty = await getProgressView(handle.db, NOBODY, "all", TODAY);
    expect(empty.from).toBe(TODAY);
    expect(empty.volume).toEqual([{ weekStart: isoWeekStart(TODAY), minutes: 0 }]);
    expect(empty.strength).toEqual([]);
    expect(empty.engine).toEqual({ paceAtHr: [], thresholdPace: [], tests: [] });
    expect(empty.crossfit).toEqual({ benchmarks: [], prs: [] });
    expect(empty.recovery).toEqual([]);
    expect(empty.enjoyment).toEqual([]);
    expect(empty.load).toMatchObject({ acute7d: 0, chronicWeeklyAvg: 0, ratio: null });
    expect(empty.heatmap.patterns.every((p) => p.value === 0 && p.bars === 0)).toBe(true);
  });
});
