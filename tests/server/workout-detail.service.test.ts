import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import * as schema from "@/db/schema";
import { seedCatalog } from "@/db/seed";
import { createTestDb, type TestDb } from "@/db/test-db";
import { runEngine } from "@/domain/engine/engine";
import { scenario } from "@/domain/engine/fixtures";
import { getWorkoutDetail } from "@/server/services/workout-detail.service";

const USER_A = "00000000-0000-4000-8000-0000000000a2";
const USER_B = "00000000-0000-4000-8000-0000000000b2";
const TODAY = "2026-09-28";
const TZ = "Europe/Paris";

let handle: TestDb;

beforeAll(async () => {
  handle = await createTestDb();
  await handle.db.insert(schema.users).values([
    { id: USER_A, email: "detail-a@example.test", displayName: "A" },
    { id: USER_B, email: "detail-b@example.test", displayName: "B" },
  ]);
  await seedCatalog(handle.db);
});

afterAll(async () => {
  await handle.close();
});

async function insertWorkout(values: Partial<typeof schema.workouts.$inferInsert> = {}) {
  const [row] = await handle.db
    .insert(schema.workouts)
    .values({
      userId: USER_A,
      type: "strength",
      source: "planned_user",
      date: TODAY,
      title: "Séance",
      ...values,
    })
    .returning();
  if (!row) throw new Error("insert returned no row");
  return row;
}

describe("getWorkoutDetail", () => {
  it("returns null for another user's workout or an unknown id", async () => {
    const w = await insertWorkout();
    expect(await getWorkoutDetail(handle.db, USER_B, w.id, TZ)).toBeNull();
    expect(await getWorkoutDetail(handle.db, USER_A, crypto.randomUUID(), TZ)).toBeNull();
  });

  it("builds the strength detail: ordered exercises, sets, best e1RM and PR flag", async () => {
    const w = await insertWorkout({
      status: "done",
      startAt: new Date("2026-09-28T16:30:00Z"),
      plannedDurationMin: 60,
      actualDurationMin: 55,
      rpe: 8,
      feeling: "good",
      sessionRpeLoad: 440,
      finishedAt: new Date("2026-09-28T17:25:00Z"),
    });
    const prescription = {
      sets: 3,
      repMin: 4,
      repMax: 6,
      targetRpeMin: 7,
      targetRpeMax: 8.5,
      intent: "strength" as const,
      loadSuggestionKg: 100,
      restSec: null,
    };
    const [press, squat] = await handle.db
      .insert(schema.workoutExercises)
      .values([
        {
          userId: USER_A,
          workoutId: w.id,
          date: TODAY,
          order: 1,
          exerciseId: "strict_press",
          prescription,
        },
        {
          userId: USER_A,
          workoutId: w.id,
          date: TODAY,
          order: 0,
          exerciseId: "back_squat",
          prescription,
        },
      ])
      .returning();
    if (!press || !squat) throw new Error("insert returned no rows");
    const set = (
      wx: typeof squat,
      setIndex: number,
      reps: number,
      weightKg: number,
      e1rmKg: number | null,
      isWarmup = false,
    ) => ({
      userId: USER_A,
      workoutId: w.id,
      workoutExerciseId: wx.id,
      exerciseId: wx.exerciseId,
      date: TODAY,
      setIndex,
      reps,
      weightKg,
      e1rmKg,
      isWarmup,
      completedAt: new Date(`2026-09-28T16:${40 + setIndex}:00Z`),
    });
    await handle.db
      .insert(schema.strengthSets)
      .values([
        set(squat, 0, 5, 60, null, true),
        set(squat, 1, 5, 100, 116.7),
        set(squat, 2, 5, 105, 122.5),
        set(press, 0, 6, 50, 60),
      ]);
    await handle.db.insert(schema.personalRecords).values({
      userId: USER_A,
      kind: "e1rm",
      exerciseId: "back_squat",
      value: 122.5,
      unit: "kg",
      reps: 5,
      achievedAt: new Date("2026-09-28T16:42:00Z"),
      workoutId: w.id,
      source: "CALCULATED",
      estimated: true,
      algorithmVersion: "epley_v1",
      previousValue: 118,
    });

    const view = await getWorkoutDetail(handle.db, USER_A, w.id, TZ);
    expect(view).not.toBeNull();
    if (!view) return;
    expect(view).toMatchObject({
      type: "strength",
      status: "done",
      startMinute: 18 * 60 + 30,
      actualDurationMin: 55,
      rpe: 8,
      feeling: "good",
      funScore: 7,
      sessionRpeLoad: 440,
    });
    expect(view.crossfit).toBeNull();
    expect(view.cardio).toBeNull();
    expect(view.coach).toBeNull();
    expect(view.why).toBeNull();
    const s = view.strength;
    expect(s).not.toBeNull();
    if (!s) return;
    expect(s.exercises.map((e) => e.exerciseId)).toEqual(["back_squat", "strict_press"]);
    expect(s.exercises[0]?.name).toBe("Back squat");
    expect(s.exercises[0]?.prescription?.sets).toBe(3);
    expect(s.exercises[0]?.sets).toHaveLength(3);
    expect(s.exercises[0]?.sets[0]?.isWarmup).toBe(true);
    expect(s.exercises[0]?.bestSetE1rmKg).toBe(122.5);
    expect(s.exercises[0]?.bestSetId).toBe(s.exercises[0]?.sets[2]?.id);
    expect(s.exercises[0]?.isPr).toBe(true);
    expect(s.exercises[0]?.previousBestKg).toBe(118);
    expect(s.exercises[1]?.isPr).toBe(false);
    expect(s.exercises[1]?.bestSetE1rmKg).toBe(60);
    expect(s.workingSets).toBe(3);
    expect(s.volumeKg).toBe(5 * 100 + 5 * 105 + 6 * 50);
  });

  it("builds the crossfit detail with the score and benchmark name, plus planned/actual analyses", async () => {
    const w = await insertWorkout({
      type: "crossfit",
      source: "wod_inbox",
      status: "done",
      fixed: true,
      title: "CrossFit — Fran",
    });
    await handle.db.insert(schema.crossfitWorkouts).values({
      userId: USER_A,
      workoutId: w.id,
      benchmarkId: "fran",
      timeDomain: "short",
      score: { kind: "time", value: 312, rx: true },
      normalizedWod: {
        title: "Fran",
        sourceText: "21-15-9 thrusters 43/30 pull-ups",
        parts: [
          {
            kind: "metcon",
            format: "for_time",
            title: null,
            durationMin: null,
            timeCapMin: null,
            rounds: null,
            repScheme: [21, 15, 9],
            intervalSec: null,
            restSec: null,
            alternating: false,
            sets: null,
            reps: null,
            movements: [
              {
                raw: "thrusters 43/30",
                exerciseId: "thruster",
                name: "Thruster",
                resolutionConfidence: 1,
                hintedPattern: null,
                reps: null,
                repScheme: null,
                calories: null,
                caloriesAlt: null,
                distanceM: null,
                durationSec: null,
                heightCm: null,
                load: { value: 43, unit: "kg", alt: 30, qualifier: null },
                sets: null,
                modifiers: [],
                pace: null,
              },
            ],
            notes: null,
          },
        ],
        parseConfidence: 0.9,
        parser: "HEURISTIC",
        parserVersion: "test",
        warnings: [],
      },
    });
    const base = {
      userId: USER_A,
      workoutId: w.id,
      date: TODAY,
      patternExposure: {},
      muscleExposure: {},
      energySystems: [],
      heavyStrength: false,
      source: "CALCULATED",
      algorithmVersion: "wod_analyzer_v1",
    };
    await handle.db.insert(schema.workoutAnalyses).values([
      {
        ...base,
        phase: "planned",
        intensity: "hard",
        confidence: "HIGH",
        impactUnits: 1,
        stimulusCredits: { hi_conditioning: 1, crossfit_exposure: 0.5, strength_lower: 0 },
        loadVector: {
          cardiovascular: 8,
          muscular_lower: 5,
          muscular_upper: 5,
          impact: 1,
          eccentric: 3,
          technical: 2,
        },
      },
      {
        ...base,
        phase: "actual",
        intensity: "hard",
        confidence: "MEDIUM",
        impactUnits: 1,
        stimulusCredits: { hi_conditioning: 1, crossfit_exposure: 0.5 },
        loadVector: {
          cardiovascular: 9,
          muscular_lower: 5.5,
          muscular_upper: 5.5,
          impact: 1,
          eccentric: 3.3,
          technical: 2.2,
        },
      },
    ]);
    const view = await getWorkoutDetail(handle.db, USER_A, w.id, TZ);
    expect(view?.crossfit).toMatchObject({
      benchmarkId: "fran",
      benchmarkName: "Fran",
      timeDomain: "short",
      score: { kind: "time", value: 312, rx: true },
    });
    expect(view?.crossfit?.wod?.parts[0]?.repScheme).toEqual([21, 15, 9]);
    expect(view?.strength).toBeNull();
    const planned = view?.analysis.planned;
    const actual = view?.analysis.actual;
    expect(planned?.estimated).toBe(true);
    expect(planned?.load.map((l) => l.key)).toEqual([
      "cardiovascular",
      "muscular_lower",
      "muscular_upper",
      "impact",
      "eccentric",
      "technical",
    ]);
    expect(planned?.load[0]).toEqual({ key: "cardiovascular", label: "cardio", value: 8 });
    // Zero credits are not listed; labels are French.
    expect(planned?.credits.map((c) => c.key).sort()).toEqual([
      "crossfit_exposure",
      "hi_conditioning",
    ]);
    expect(planned?.credits.find((c) => c.key === "hi_conditioning")?.label).toBe(
      "conditioning intense",
    );
    expect(actual?.confidence).toBe("MEDIUM");
    expect(actual?.load[0]?.value).toBe(9);
  });

  it("builds the cardio detail: step count, estimated duration and Garmin status", async () => {
    const w = await insertWorkout({ type: "cardio", title: "Run — Zone 2" });
    await handle.db.insert(schema.cardioWorkouts).values({
      userId: USER_A,
      workoutId: w.id,
      modality: "running",
      workoutKind: "zone2",
      garminSyncStatus: "pending",
      steps: [
        { kind: "warmup", durationSec: 600, target: { type: "hr_zone", zone: 1 } },
        {
          kind: "repeat",
          repeat: {
            times: 2,
            steps: [
              { kind: "work", durationSec: 900, target: { type: "hr_zone", zone: 2 } },
              { kind: "recovery", durationSec: 60 },
            ],
          },
        },
        { kind: "cooldown", durationSec: 300 },
      ],
    });
    const view = await getWorkoutDetail(handle.db, USER_A, w.id, TZ);
    expect(view?.cardio).toMatchObject({
      modality: "running",
      kind: "zone2",
      stepCount: 6,
      estimatedDurationMin: 47,
      garminSyncStatus: "pending",
    });
    expect(view?.cardio?.steps[0]).toEqual({
      kind: "warmup",
      durationSec: 600,
      distanceM: null,
      target: "Z1",
    });
  });

  it("builds the coach detail and links activities and the recommendation explanation", async () => {
    const input = scenario();
    const rec = runEngine(input);
    const [stored] = await handle.db
      .insert(schema.recommendations)
      .values({
        userId: USER_A,
        date: "2026-09-29",
        version: 1,
        engineVersion: rec.engineVersion,
        inputsSnapshot: input,
        output: rec,
        rulesTriggered: ["R_BALANCE_GAP", "R_SAFETY_PAIN"],
        explanation: "Il manque du seuil cette semaine.",
        confidence: "MEDIUM",
      })
      .returning({ id: schema.recommendations.id });
    if (!stored) throw new Error("insert returned no row");
    const w = await insertWorkout({
      type: "coach_session",
      source: "manual",
      status: "done",
      title: "Coaching CrossFit",
      recommendationId: stored.id,
    });
    await handle.db.insert(schema.coachSessions).values({
      userId: USER_A,
      workoutId: w.id,
      demoLevel: "light",
      standingMinutes: 120,
      perceivedFatigue: 2,
    });
    await handle.db.insert(schema.activities).values([
      {
        userId: USER_A,
        provider: "fit_import",
        fingerprint: "running|29856421",
        sport: "running",
        startAt: new Date("2026-09-28T07:00:00Z"),
        localDate: TODAY,
        durationSec: 1800,
        distanceM: 5000,
        avgHr: 142,
        parserVersion: "fit_v1",
        workoutId: w.id,
      },
      {
        userId: USER_B,
        provider: "fit_import",
        fingerprint: "running|29856422",
        sport: "running",
        startAt: new Date("2026-09-28T08:00:00Z"),
        localDate: TODAY,
        durationSec: 1000,
        parserVersion: "fit_v1",
        workoutId: null,
      },
    ]);
    const view = await getWorkoutDetail(handle.db, USER_A, w.id, TZ);
    expect(view?.coach).toEqual({ demoLevel: "light", standingMinutes: 120, perceivedFatigue: 2 });
    expect(view?.activities).toHaveLength(1);
    expect(view?.activities[0]).toMatchObject({
      sport: "running",
      durationSec: 1800,
      distanceM: 5000,
      avgHr: 142,
    });
    expect(view?.why).toEqual({
      explanation: "Il manque du seuil cette semaine.",
      rulesTriggered: ["R_BALANCE_GAP", "R_SAFETY_PAIN"],
      confidence: "MEDIUM",
      date: "2026-09-29",
    });
  });
});
