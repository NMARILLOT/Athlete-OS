import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { seedCatalog } from "@/db/seed";
import { createTestDb, type TestDb } from "@/db/test-db";
import { getCatalogEntry } from "@/domain/engine";
import { analyzeWod, NormalizedWodSchema, parseWodText, type NormalizedWod } from "@/domain/wod";
import { assembleEngineInput } from "@/server/services/engine-input";
import { recompute } from "@/server/services/recommendation.service";
import { createStrengthWorkoutFromTemplate } from "@/server/services/strength-session.service";
import {
  backDatedFinish,
  completeWorkout,
  createCrossfitWorkoutFromWod,
  createWorkoutFromOption,
  findOpenWorkoutForOption,
  logQuickWorkout,
  measuredBandFromActivities,
  optionFromCatalog,
  realisedBandFromFeedback,
  routeForWorkout,
  wodHeavyStrength,
} from "@/server/services/workout.service";

vi.mock("server-only", () => ({}));

const USER_A = "00000000-0000-4000-8000-0000000000f1";
const USER_B = "00000000-0000-4000-8000-0000000000f2";
const TZ = "Europe/Paris";
const TODAY = "2026-09-28";

let handle: TestDb;

beforeAll(async () => {
  handle = await createTestDb();
  await handle.db.insert(schema.users).values([
    { id: USER_A, email: "workout-a@example.test" },
    { id: USER_B, email: "workout-b@example.test" },
  ]);
  await seedCatalog(handle.db);
});

afterAll(async () => {
  await handle.close();
});

async function workoutRow(id: string) {
  const [w] = await handle.db.select().from(schema.workouts).where(eq(schema.workouts.id, id));
  if (!w) throw new Error("workout missing");
  return w;
}

async function actualRow(id: string) {
  const [a] = await handle.db
    .select()
    .from(schema.workoutAnalyses)
    .where(
      and(eq(schema.workoutAnalyses.workoutId, id), eq(schema.workoutAnalyses.phase, "actual")),
    );
  return a ?? null;
}

const strengthWod = (
  movement: Record<string, unknown>,
  part: Record<string, unknown> = {},
  kind: "strength" | "metcon" = "strength",
): NormalizedWod =>
  NormalizedWodSchema.parse({
    title: null,
    sourceText: "test",
    parseConfidence: 1,
    parser: "USER",
    parserVersion: "test",
    parts: [
      {
        kind,
        format: kind === "strength" ? "sets_reps" : "amrap",
        sets: 5,
        reps: 5,
        durationMin: kind === "metcon" ? 12 : null,
        ...part,
        movements: [
          { raw: "back squat", exerciseId: "back_squat", name: "Back squat", ...movement },
        ],
      },
    ],
  });

describe("wodHeavyStrength", () => {
  const analysis = (w: NormalizedWod) => analyzeWod(w);

  it("counts a compound strength part as heavy only with a heavy load or low reps without reference", () => {
    const light = strengthWod({ load: { value: 0, unit: "kg", qualifier: "light" } });
    expect(wodHeavyStrength(light, analysis(light))).toBe(false);
    const sixty = strengthWod({ load: { value: 60, unit: "percent_1rm" } });
    expect(wodHeavyStrength(sixty, analysis(sixty))).toBe(false);
    const eightyFive = strengthWod({ load: { value: 85, unit: "percent_1rm" } });
    expect(wodHeavyStrength(eightyFive, analysis(eightyFive))).toBe(true);
    const heavy = strengthWod({ load: { value: 0, unit: "kg", qualifier: "heavy" } });
    expect(wodHeavyStrength(heavy, analysis(heavy))).toBe(true);
    const bare5x5 = strengthWod({});
    expect(wodHeavyStrength(bare5x5, analysis(bare5x5))).toBe(true);
    const bare3x10 = strengthWod({ reps: 10 }, { sets: 3, reps: 10 });
    expect(wodHeavyStrength(bare3x10, analysis(bare3x10))).toBe(false);
  });

  it("turns an absolute load into a share of the known e1RM", () => {
    const hundred = strengthWod({ load: { value: 100, unit: "kg" } });
    expect(wodHeavyStrength(hundred, analysis(hundred), { back_squat: 150 })).toBe(false);
    expect(wodHeavyStrength(hundred, analysis(hundred), { back_squat: 120 })).toBe(true);
  });

  it("never counts metcon loads or non-compound movements, and honours an analyzer flag", () => {
    const metcon = strengthWod({ load: { value: 100, unit: "kg" }, reps: 5 }, {}, "metcon");
    expect(wodHeavyStrength(metcon, analysis(metcon), { back_squat: 100 })).toBe(false);
    const kb = strengthWod({
      raw: "kettlebell swing",
      exerciseId: "kettlebell_swing",
      name: "KB swing",
      load: { value: 32, unit: "kg", qualifier: "heavy" },
    });
    expect(wodHeavyStrength(kb, analysis(kb))).toBe(false);
    const declared = { ...analysis(kb), heavyStrength: true };
    expect(wodHeavyStrength(kb, declared)).toBe(true);
  });

  it("stores heavyStrength=false for a light technique piece before a metcon (dominant = mixed)", async () => {
    const wod = parseWodText(
      "Strength\nFront squat 3x10 light\n\nMetcon\nAMRAP 12\n10 burpees\n15 wall balls 9/6 kg",
    );
    const a = analyzeWod(wod);
    expect(a.dominant).toBe("mixed");
    const [item] = await handle.db
      .insert(schema.wodInboxItems)
      .values({ userId: USER_A, inputKind: "paste", rawText: wod.sourceText, contentHash: "h1" })
      .returning();
    if (!item) throw new Error("inbox insert failed");
    const created = await createCrossfitWorkoutFromWod(handle.db, USER_A, {
      date: "2026-09-30",
      startMinute: 18 * 60,
      timezone: TZ,
      wod,
      analysis: a,
      inboxItemId: item.id,
    });
    const [planned] = await handle.db
      .select()
      .from(schema.workoutAnalyses)
      .where(eq(schema.workoutAnalyses.workoutId, created.id));
    expect(planned?.heavyStrength).toBe(false);
  });
});

describe("completeWorkout", () => {
  it("upgrades the realised intensity from the RPE (metabolic axis) and feeds hardDone6d", async () => {
    const [w] = await handle.db
      .insert(schema.workouts)
      .values({
        userId: USER_A,
        type: "crossfit",
        source: "wod_inbox",
        status: "planned",
        date: TODAY,
        startAt: new Date("2026-09-28T16:00:00.000Z"),
        plannedDurationMin: 40,
        title: "CrossFit — Chipper",
        plannedIntensity: "moderate",
        intensitySource: "CALCULATED",
        expectedRpe: 6.5,
        fixed: true,
      })
      .returning();
    if (!w) throw new Error("insert failed");
    await handle.db.insert(schema.workoutAnalyses).values({
      userId: USER_A,
      workoutId: w.id,
      phase: "planned",
      date: TODAY,
      loadVector: {
        cardiovascular: 5.5,
        muscular_lower: 4,
        muscular_upper: 3,
        impact: 2,
        eccentric: 2,
        technical: 2,
      },
      stimulusCredits: { crossfit_exposure: 1 },
      intensity: "moderate",
      heavyStrength: false,
      source: "CALCULATED",
      algorithmVersion: "wod_analyzer_v1",
      confidence: "HIGH",
    });
    await completeWorkout(handle.db, USER_A, {
      workoutId: w.id,
      rpe: 9.5,
      feeling: "too_hard",
      painReported: false,
      now: new Date("2026-09-28T17:00:00.000Z"),
      timezone: TZ,
    });
    const done = await workoutRow(w.id);
    expect(done.realisedIntensity).toBe("hard");
    expect(done.intensitySource).toBe("CALCULATED");
    // No duration was measured or declared: the column stays null, the load uses the planned one.
    expect(done.actualDurationMin).toBeNull();
    expect(done.sessionRpeLoad).toBe(380);
    expect(done.finishedAt?.toISOString()).toBe("2026-09-28T17:00:00.000Z");
    const actual = await actualRow(w.id);
    expect(actual?.intensity).toBe("hard");
    expect(actual?.algorithmVersion).toBe("wod_analyzer_v1+actual_scaling_v1");

    const next = await recompute(handle.db, USER_A, {
      now: new Date("2026-09-29T07:00:00.000Z"),
      timezone: TZ,
    });
    expect(next.output.trace.derived.hardDone6d).toBeGreaterThanOrEqual(1);
  });

  it("never downgrades a planned band and caps heavy strength at moderate", () => {
    expect(
      realisedBandFromFeedback("hard", { loadVector: null, rpe: 3, heavyStrength: false }),
    ).toBe("hard");
    expect(
      realisedBandFromFeedback("moderate", { loadVector: null, rpe: 9, heavyStrength: true }),
    ).toBe("moderate");
    expect(
      realisedBandFromFeedback("easy", { loadVector: null, rpe: 9, heavyStrength: false }),
    ).toBe("hard");
    expect(
      realisedBandFromFeedback("easy", { loadVector: null, rpe: null, heavyStrength: false }),
    ).toBe("easy");
    expect(realisedBandFromFeedback(null, { loadVector: null, rpe: 6, heavyStrength: false })).toBe(
      "moderate",
    );
  });

  it("keeps the strength tracker's actual analysis, band, duration and finish on 'Modifier le ressenti'", async () => {
    const finishedAt = new Date("2026-09-27T18:00:00.000Z");
    const [w] = await handle.db
      .insert(schema.workouts)
      .values({
        userId: USER_A,
        type: "strength",
        source: "planned_engine",
        status: "done",
        date: "2026-09-27",
        startAt: new Date("2026-09-27T17:00:00.000Z"),
        plannedDurationMin: 60,
        actualDurationMin: 52,
        title: "Strength — Lower",
        plannedIntensity: "hard",
        realisedIntensity: "easy",
        intensitySource: "CALCULATED",
        expectedRpe: 8,
        rpe: 5,
        finishedAt,
      })
      .returning();
    if (!w) throw new Error("insert failed");
    const plannedVector = {
      cardiovascular: 2,
      muscular_lower: 8,
      muscular_upper: 2,
      impact: 0,
      eccentric: 7,
      technical: 4,
    };
    const actualVector = { ...plannedVector, muscular_lower: 1.6, eccentric: 1.4 };
    await handle.db.insert(schema.workoutAnalyses).values([
      {
        userId: USER_A,
        workoutId: w.id,
        phase: "planned",
        date: "2026-09-27",
        loadVector: plannedVector,
        stimulusCredits: { strength_lower: 1 },
        intensity: "moderate",
        heavyStrength: true,
        source: "ENGINE",
        algorithmVersion: "candidate_catalog_v1",
        confidence: "HIGH",
      },
      {
        userId: USER_A,
        workoutId: w.id,
        phase: "actual",
        date: "2026-09-27",
        loadVector: actualVector,
        stimulusCredits: { strength_lower: 0.3 },
        intensity: "easy",
        heavyStrength: false,
        source: "CALCULATED",
        algorithmVersion: "strength_actual_v1",
        confidence: "HIGH",
      },
    ]);
    await completeWorkout(handle.db, USER_A, {
      workoutId: w.id,
      rpe: 9,
      feeling: "good",
      painReported: true,
      notes: "genou droit",
      now: new Date("2026-09-29T07:00:00.000Z"),
      timezone: TZ,
    });
    const row = await workoutRow(w.id);
    expect(row).toMatchObject({
      rpe: 9,
      feeling: "good",
      painReported: true,
      notes: "genou droit",
      sessionRpeLoad: 468,
      realisedIntensity: "easy",
      intensitySource: "CALCULATED",
      actualDurationMin: 52,
    });
    expect(row.finishedAt?.toISOString()).toBe(finishedAt.toISOString());
    const actual = await actualRow(w.id);
    expect(actual?.algorithmVersion).toBe("strength_actual_v1");
    expect(actual?.loadVector).toEqual(actualVector);
    expect(actual?.intensity).toBe("easy");
  });

  it("keeps an imported activity's measured finish, duration and HR-derived band", async () => {
    const finishedAt = new Date("2026-09-26T06:30:00.000Z");
    const [w] = await handle.db
      .insert(schema.workouts)
      .values({
        userId: USER_A,
        type: "cardio",
        source: "garmin",
        status: "done",
        date: "2026-09-26",
        startAt: new Date("2026-09-26T06:00:00.000Z"),
        actualDurationMin: 30,
        title: "Course",
        plannedIntensity: null,
        realisedIntensity: "moderate",
        intensitySource: "CALCULATED",
        finishedAt,
      })
      .returning();
    if (!w) throw new Error("insert failed");
    await handle.db.insert(schema.workoutAnalyses).values({
      userId: USER_A,
      workoutId: w.id,
      phase: "actual",
      date: "2026-09-26",
      loadVector: {
        cardiovascular: 4,
        muscular_lower: 2,
        muscular_upper: 0,
        impact: 3,
        eccentric: 1,
        technical: 0,
      },
      stimulusCredits: { aerobic_easy: 0.6 },
      intensity: "moderate",
      heavyStrength: false,
      source: "CALCULATED",
      algorithmVersion: "activity_v1",
      confidence: "MEDIUM",
    });
    await completeWorkout(handle.db, USER_A, {
      workoutId: w.id,
      rpe: 7,
      feeling: "meh",
      painReported: false,
      now: new Date("2026-09-29T07:00:00.000Z"),
      timezone: TZ,
    });
    const row = await workoutRow(w.id);
    expect(row).toMatchObject({
      rpe: 7,
      sessionRpeLoad: 210,
      realisedIntensity: "moderate",
      actualDurationMin: 30,
    });
    expect(row.finishedAt?.toISOString()).toBe(finishedAt.toISOString());
    expect((await actualRow(w.id))?.algorithmVersion).toBe("activity_v1");
  });

  it("fills the null band of an imported activity without zones from the RPE and re-derives it on re-feedback", async () => {
    // As createDoneWorkout stores a run for a user without LTHR: band null (nothing measured),
    // an activity_v1 actual row at the synthetic "easy" prior, and the linked activity row.
    const [w] = await handle.db
      .insert(schema.workouts)
      .values({
        userId: USER_A,
        type: "cardio",
        source: "garmin",
        status: "done",
        date: "2026-09-25",
        startAt: new Date("2026-09-25T06:00:00.000Z"),
        actualDurationMin: 40,
        title: "Course",
        plannedIntensity: null,
        realisedIntensity: null,
        intensitySource: "CALCULATED",
        finishedAt: new Date("2026-09-25T06:40:00.000Z"),
        sessionRpeLoad: null,
      })
      .returning();
    if (!w) throw new Error("insert failed");
    await handle.db.insert(schema.workoutAnalyses).values({
      userId: USER_A,
      workoutId: w.id,
      phase: "actual",
      date: "2026-09-25",
      loadVector: {
        cardiovascular: 2.5,
        muscular_lower: 2,
        muscular_upper: 0,
        impact: 3,
        eccentric: 1,
        technical: 0,
      },
      stimulusCredits: { aerobic_easy: 0.5 },
      intensity: "easy",
      heavyStrength: false,
      source: "CALCULATED",
      algorithmVersion: "cardio_builder_v1+activity_v1",
      confidence: "LOW",
    });
    await handle.db.insert(schema.activities).values({
      userId: USER_A,
      provider: "fit_import",
      fingerprint: "running|29856000",
      sport: "running",
      startAt: new Date("2026-09-25T06:00:00.000Z"),
      localDate: "2026-09-25",
      durationSec: 2400,
      avgHr: 178,
      parserVersion: "fit_v1",
      workoutId: w.id,
    });
    await completeWorkout(handle.db, USER_A, {
      workoutId: w.id,
      rpe: 9,
      feeling: "too_hard",
      painReported: false,
      now: new Date("2026-09-25T08:00:00.000Z"),
      timezone: TZ,
    });
    const row = await workoutRow(w.id);
    expect(row).toMatchObject({
      rpe: 9,
      realisedIntensity: "hard",
      intensitySource: "CALCULATED",
      actualDurationMin: 40,
      sessionRpeLoad: 360,
    });
    const actual = await actualRow(w.id);
    expect(actual?.intensity).toBe("hard");
    expect(actual?.algorithmVersion).toBe("cardio_builder_v1+activity_v1");
    expect(actual?.loadVector.cardiovascular).toBe(2.5);
    // The engine counts a maximal effort as hard, not as the "easy" prior.
    const input = await assembleEngineInput(handle.db, USER_A, {
      now: new Date("2026-09-26T07:00:00.000Z"),
      timezone: TZ,
    });
    expect(input.history.find((s) => s.id === w.id)).toMatchObject({ intensity: "hard", rpe: 9 });
    // Nothing measured the band: a corrected RPE re-derives it instead of keeping the first one.
    await completeWorkout(handle.db, USER_A, {
      workoutId: w.id,
      rpe: 4,
      feeling: "good",
      painReported: false,
      now: new Date("2026-09-25T09:00:00.000Z"),
      timezone: TZ,
    });
    expect(await workoutRow(w.id)).toMatchObject({ rpe: 4, realisedIntensity: "easy" });
    expect((await actualRow(w.id))?.intensity).toBe("easy");
  });

  it("lets a corrected lower RPE bring the band back to the plan: an RPE upgrade is never a floor", async () => {
    const feedback = (workoutId: string, rpe: number, hour: number) =>
      completeWorkout(handle.db, USER_B, {
        workoutId,
        rpe,
        feeling: "good",
        painReported: false,
        now: new Date(`2026-09-25T${String(hour).padStart(2, "0")}:00:00.000Z`),
        timezone: TZ,
      });
    const create = (kind: string, startMinute: number) => {
      const option = optionFromCatalog(kind);
      if (!option) throw new Error("catalog");
      return createWorkoutFromOption(handle.db, USER_B, {
        option,
        date: "2026-09-25",
        timezone: TZ,
        recommendationId: null,
        startMinute,
      });
    };
    // Zone 2 run (cardio 2.5, easy): a mis-tapped RPE 9 upgrades it, the corrected RPE 4 undoes it.
    const easy = await create("run_easy_45", 8 * 60);
    await feedback(easy.id, 9, 10);
    expect(await workoutRow(easy.id)).toMatchObject({
      realisedIntensity: "moderate",
      intensitySource: "CALCULATED",
    });
    expect((await actualRow(easy.id))?.intensity).toBe("moderate");
    await feedback(easy.id, 4, 11);
    expect(await workoutRow(easy.id)).toMatchObject({
      rpe: 4,
      realisedIntensity: "easy",
      intensitySource: "ENGINE",
    });
    expect((await actualRow(easy.id))?.intensity).toBe("easy");
    // Invariant on any kind: RPE 9 then RPE 4 ends exactly where a fresh RPE 4 feedback ends (twin).
    const corrected = await create("run_long_90", 12 * 60);
    const twin = await create("run_long_90", 15 * 60);
    await feedback(corrected.id, 9, 14);
    expect((await workoutRow(corrected.id)).realisedIntensity).toBe("hard");
    await feedback(corrected.id, 4, 17);
    await feedback(twin.id, 4, 17);
    const [a, b] = [await workoutRow(corrected.id), await workoutRow(twin.id)];
    expect(a.realisedIntensity).not.toBe("hard");
    expect(a.realisedIntensity).toBe(b.realisedIntensity);
    expect(a.intensitySource).toBe(b.intensitySource);
    expect((await actualRow(corrected.id))?.intensity).toBe((await actualRow(twin.id))?.intensity);
  });

  it("keeps the band measured by a linked activity's HR zones as the floor across feedbacks", async () => {
    const option = optionFromCatalog("run_long_90");
    if (!option) throw new Error("catalog");
    const created = await createWorkoutFromOption(handle.db, USER_B, {
      option,
      date: "2026-09-24",
      timezone: TZ,
      recommendationId: null,
      startMinute: 7 * 60,
    });
    const [zoneSet] = await handle.db
      .insert(schema.hrZoneSets)
      .values({
        userId: USER_B,
        validFrom: "2026-09-01",
        method: "lthr",
        lthr: 165,
        zones: [
          { zone: 1, minBpm: 0, maxBpm: 139 },
          { zone: 2, minBpm: 140, maxBpm: 150 },
          { zone: 3, minBpm: 151, maxBpm: 160 },
          { zone: 4, minBpm: 161, maxBpm: 170 },
          { zone: 5, minBpm: 171, maxBpm: 220 },
        ],
        source: "USER",
        confidence: "MEDIUM",
      })
      .returning();
    if (!zoneSet) throw new Error("zone set insert failed");
    // As linkPlannedWorkout stores it: 25 min in Z3 → measured "moderate" over an "easy" plan.
    const [planned] = await handle.db
      .select()
      .from(schema.workoutAnalyses)
      .where(eq(schema.workoutAnalyses.workoutId, created.id));
    if (!planned) throw new Error("planned analysis missing");
    await handle.db
      .update(schema.workouts)
      .set({
        status: "done",
        actualDurationMin: 90,
        realisedIntensity: "moderate",
        intensitySource: "CALCULATED",
        finishedAt: new Date("2026-09-24T06:30:00.000Z"),
      })
      .where(eq(schema.workouts.id, created.id));
    await handle.db.insert(schema.workoutAnalyses).values({
      userId: USER_B,
      workoutId: created.id,
      phase: "actual",
      date: "2026-09-24",
      loadVector: planned.loadVector,
      stimulusCredits: planned.stimulusCredits,
      intensity: "moderate",
      heavyStrength: false,
      source: "CALCULATED",
      algorithmVersion: `${planned.algorithmVersion}+actual_scaling_v1`,
      confidence: "MEDIUM",
    });
    const timeInZones = { z1: 10, z2: 30, z3: 25, z4: 5, z5: 0 };
    await handle.db.insert(schema.activities).values({
      userId: USER_B,
      provider: "fit_import",
      fingerprint: "running|29854560",
      sport: "running",
      startAt: new Date("2026-09-24T05:00:00.000Z"),
      localDate: "2026-09-24",
      durationSec: 5400,
      avgHr: 156,
      zoneSetId: zoneSet.id,
      timeInZones,
      parserVersion: "fit_v1",
      workoutId: created.id,
    });
    expect(
      measuredBandFromActivities([{ zoneSetId: zoneSet.id, timeInZones, durationSec: 5400 }], null),
    ).toBe("moderate");
    // Too few zone minutes (< half the duration) or no zone set: nothing measured.
    expect(
      measuredBandFromActivities(
        [{ zoneSetId: zoneSet.id, timeInZones: { ...timeInZones, z2: 0 }, durationSec: 5400 }],
        null,
      ),
    ).toBeNull();
    expect(
      measuredBandFromActivities([{ zoneSetId: null, timeInZones, durationSec: 5400 }], null),
    ).toBeNull();

    const feedback = (rpe: number, hour: number) =>
      completeWorkout(handle.db, USER_B, {
        workoutId: created.id,
        rpe,
        feeling: "good",
        painReported: false,
        now: new Date(`2026-09-24T${String(hour).padStart(2, "0")}:00:00.000Z`),
        timezone: TZ,
      });
    // A low RPE never lowers a measured band …
    await feedback(4, 8);
    expect(await workoutRow(created.id)).toMatchObject({
      realisedIntensity: "moderate",
      intensitySource: "CALCULATED",
    });
    // … a high RPE upgrades it …
    await feedback(9, 9);
    expect((await workoutRow(created.id)).realisedIntensity).toBe("hard");
    expect((await actualRow(created.id))?.intensity).toBe("hard");
    // … and a corrected RPE returns to the measured band, not to the plan's "easy".
    await feedback(4, 10);
    expect(await workoutRow(created.id)).toMatchObject({
      realisedIntensity: "moderate",
      intensitySource: "CALCULATED",
    });
    expect((await actualRow(created.id))?.intensity).toBe("moderate");
  });

  it("persists a declared duration and re-scales its own actual analysis on a second feedback", async () => {
    const option = optionFromCatalog("run_easy_45");
    if (!option) throw new Error("catalog");
    const created = await createWorkoutFromOption(handle.db, USER_B, {
      option,
      date: "2026-09-27",
      timezone: TZ,
      recommendationId: null,
      startMinute: 8 * 60,
    });
    await completeWorkout(handle.db, USER_B, {
      workoutId: created.id,
      rpe: 4,
      feeling: "great",
      painReported: false,
      actualDurationMin: 50,
      now: new Date("2026-09-27T09:00:00.000Z"),
      timezone: TZ,
    });
    const first = await workoutRow(created.id);
    expect(first.actualDurationMin).toBe(50);
    expect(first.sessionRpeLoad).toBe(200);
    expect(first.finishedAt?.toISOString()).toBe("2026-09-27T09:00:00.000Z");
    const firstActual = await actualRow(created.id);
    await completeWorkout(handle.db, USER_B, {
      workoutId: created.id,
      rpe: 6,
      feeling: "meh",
      painReported: false,
      now: new Date("2026-09-28T09:00:00.000Z"),
      timezone: TZ,
    });
    const second = await workoutRow(created.id);
    expect(second.rpe).toBe(6);
    expect(second.actualDurationMin).toBe(50);
    expect(second.sessionRpeLoad).toBe(300);
    expect(second.finishedAt?.toISOString()).toBe("2026-09-27T09:00:00.000Z");
    const secondActual = await actualRow(created.id);
    expect(secondActual?.loadVector.cardiovascular).toBeGreaterThan(
      firstActual?.loadVector.cardiovascular ?? Infinity,
    );
  });
});

describe("logged sessions", () => {
  it("stamps a back-dated quick log at 17:00 local + duration, never at the log time", () => {
    expect(
      backDatedFinish("2026-09-01", null, 40, TZ, new Date("2026-09-28T10:00:00Z")).toISOString(),
    ).toBe("2026-09-01T15:40:00.000Z");
    const now = new Date("2026-09-28T10:00:00Z");
    expect(backDatedFinish("2026-09-28", null, 40, TZ, now).toISOString()).toBe(now.toISOString());
    expect(
      backDatedFinish("2026-09-01", new Date("2026-09-01T16:00:00Z"), 40, TZ, now).toISOString(),
    ).toBe("2026-09-01T16:40:00.000Z");
  });

  it("quick-logs a past run with its finish on that day", async () => {
    const created = await logQuickWorkout(handle.db, USER_B, {
      date: "2026-09-01",
      type: "cardio",
      title: "Footing",
      durationMin: 40,
      rpe: 5,
      feeling: "good",
      intensity: "easy",
      kind: "run_easy_45",
      timezone: TZ,
    });
    const row = await workoutRow(created.id);
    expect(row.finishedAt?.toISOString()).toBe("2026-09-01T15:40:00.000Z");
  });
});

describe("START resolution", () => {
  it("builds an option from the catalog only", () => {
    expect(optionFromCatalog("nuclear")).toBeNull();
    const o = optionFromCatalog("run_easy_45");
    const e = getCatalogEntry("run_easy_45");
    expect(o).toMatchObject({
      kind: "run_easy_45",
      family: e?.family,
      durationMin: e?.durationMin,
      intensity: e?.intensity,
      loadVector: e?.loadVector,
    });
  });

  it("finds today's planned session by id or by kind so START never duplicates it", async () => {
    const { workoutId } = await createStrengthWorkoutFromTemplate(handle.db, USER_B, {
      templateId: "full_a",
      date: TODAY,
    });
    const byId = await findOpenWorkoutForOption(handle.db, USER_B, {
      date: TODAY,
      kind: "strength_full",
      plannedId: workoutId,
    });
    expect(byId).toEqual({ id: workoutId, type: "strength", fixed: false });
    const byKind = await findOpenWorkoutForOption(handle.db, USER_B, {
      date: TODAY,
      kind: "strength_full",
    });
    expect(byKind?.id).toBe(workoutId);
    expect(
      await findOpenWorkoutForOption(handle.db, USER_B, { date: TODAY, kind: "run_easy_45" }),
    ).toBeNull();
    expect(
      await findOpenWorkoutForOption(handle.db, USER_A, {
        date: TODAY,
        kind: "strength_full",
        plannedId: workoutId,
      }),
    ).toBeNull();
    expect(routeForWorkout({ id: workoutId, type: "strength" })).toBe(
      `/train/strength/${workoutId}`,
    );
    expect(routeForWorkout({ id: "x", type: "cardio" })).toBe("/train/cardio/x");
    expect(routeForWorkout({ id: "x", type: "crossfit", fixed: true })).toBe("/workouts/x");
  });
});

describe("skipWorkout on a live session", () => {
  it("refuses to skip an in_progress strength workout (a finish is the only exit)", async () => {
    const { createTestDb } = await import("@/db/test-db");
    const { seedCatalog } = await import("@/db/seed");
    const schema = await import("@/db/schema");
    const { skipWorkout } = await import("@/server/services/workout.service");
    const { ValidationError } = await import("@/server/errors");
    const { eq } = await import("drizzle-orm");
    const h = await createTestDb();
    try {
      const userId = "00000000-0000-4000-8000-0000000000e9";
      await h.db.insert(schema.users).values({ id: userId, email: "e9@example.test" });
      await seedCatalog(h.db);
      const [w] = await h.db
        .insert(schema.workouts)
        .values({
          userId,
          type: "strength",
          source: "planned_user",
          status: "in_progress",
          date: "2026-09-29",
          title: "Strength — Lower",
          startAt: new Date("2026-09-29T17:00:00Z"),
        })
        .returning({ id: schema.workouts.id });
      await expect(skipWorkout(h.db, userId, w!.id)).rejects.toBeInstanceOf(ValidationError);
      const [after] = await h.db
        .select({ status: schema.workouts.status })
        .from(schema.workouts)
        .where(eq(schema.workouts.id, w!.id));
      expect(after?.status).toBe("in_progress");
    } finally {
      await h.close();
    }
  });
});
