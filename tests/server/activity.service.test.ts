import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { Encoder, Profile } from "@garmin/fitsdk";
import * as schema from "@/db/schema";
import { seedCatalog } from "@/db/seed";
import { createTestDb, type TestDb } from "@/db/test-db";
import {
  CARDIO_BUILDER_ALGORITHM_VERSION,
  CARDIO_PRESETS,
  expectedLoadProfile,
} from "@/domain/cardio";
import { ACTUAL_SCALING_VERSION } from "@/domain/load";
import { FIT_PARSER_VERSION } from "@/server/fit/parser";
import { FeatureDisabledError } from "@/server/flags";
import { GarminMockProvider } from "@/server/providers/garmin/mock";
import {
  GARMIN_IMPORT_VERSION,
  InvalidFitError,
  RUN_PR_ALGORITHM_VERSION,
  activityTitle,
  getActivityDetail,
  importActivityDetails,
  importFitFile,
  listActivities,
  modalityForSport,
  syncGarminActivities,
  toStreamPoints,
} from "@/server/services/activity.service";
import { analysisRowFromProfile } from "@/server/services/workout.service";

/**
 * Activity import pipeline on PGlite: FIT → raw payload → activities/laps/streams → zones →
 * comparable group → metrics → workout link → PRs; idempotency, Garmin mock sync, ownership.
 */
const USER_A = "00000000-0000-4000-8000-0000000000a7";
const USER_B = "00000000-0000-4000-8000-0000000000b7";
/** 5 km test provenance (spec §57, §70). */
const USER_C = "00000000-0000-4000-8000-0000000000c7";
/** Simulated data never touches the measured ledger (spec §14, §70, ADR-023). */
const USER_D = "00000000-0000-4000-8000-0000000000d7";
const TZ = "Europe/Paris";
const userA = { id: USER_A, timezone: TZ };
const userB = { id: USER_B, timezone: TZ };
const userC = { id: USER_C, timezone: TZ };
const userD = { id: USER_D, timezone: TZ };

const N = Profile.MesgNum as Record<string, number>;
type AnyMesg = Parameters<Encoder["onMesg"]>[1];
const asMesg = (m: Record<string, unknown>): AnyMesg => m as unknown as AnyMesg;
const FILE_ID = N.FILE_ID as number;
const RECORD = N.RECORD as number;
const LAP = N.LAP as number;
const SESSION = N.SESSION as number;
const ACTIVITY = N.ACTIVITY as number;

/** A running FIT with a session, two laps and HR/speed/cadence/altitude records every 5 s. */
function buildRunFit(options: {
  start: string;
  durationSec: number;
  speedMps: number;
  hr?: number | null;
  withDynamics?: boolean;
}): Uint8Array {
  const enc = new Encoder();
  const start = new Date(options.start);
  const { durationSec, speedMps } = options;
  enc.onMesg(
    FILE_ID,
    asMesg({
      type: "activity",
      manufacturer: "garmin",
      product: 4315,
      serialNumber: 3421009876,
      timeCreated: start,
    }),
  );
  for (let i = 0; i <= durationSec; i += 5) {
    const r: Record<string, unknown> = {
      timestamp: new Date(start.getTime() + i * 1000),
      distance: i * speedMps,
      speed: speedMps,
      cadence: 86,
      altitude: 120 + Math.sin(i / 100) * 5,
    };
    if (options.hr !== null && i >= 10)
      r.heartRate =
        (options.hr ?? 140) + Math.round(5 * Math.sin(i / 60)) + (i > durationSec / 2 ? 3 : 0);
    if (options.withDynamics)
      Object.assign(r, { stanceTime: 245, verticalOscillation: 82, stepLength: 1150 });
    enc.onMesg(RECORD, asMesg(r));
  }
  const half = Math.floor(durationSec / 2);
  const end = new Date(start.getTime() + durationSec * 1000);
  for (const [lapStart, lapDur] of [
    [0, half],
    [half, durationSec - half],
  ] as const) {
    enc.onMesg(
      LAP,
      asMesg({
        timestamp: new Date(start.getTime() + (lapStart + lapDur) * 1000),
        startTime: new Date(start.getTime() + lapStart * 1000),
        totalElapsedTime: lapDur,
        totalTimerTime: lapDur,
        totalDistance: Math.round(lapDur * speedMps),
        avgHeartRate: options.hr === null ? undefined : (options.hr ?? 140),
        maxHeartRate: options.hr === null ? undefined : (options.hr ?? 140) + 8,
        avgSpeed: speedMps,
        avgCadence: 86,
      }),
    );
  }
  const session: Record<string, unknown> = {
    timestamp: end,
    startTime: start,
    sport: "running",
    subSport: "generic",
    totalElapsedTime: durationSec,
    totalTimerTime: durationSec,
    totalDistance: Math.round(durationSec * speedMps),
    avgSpeed: speedMps,
    avgCadence: 86,
    totalAscent: 12,
    totalCalories: Math.round(durationSec / 6),
    avgTemperature: 14,
  };
  if (options.hr !== null)
    Object.assign(session, {
      avgHeartRate: options.hr ?? 140,
      maxHeartRate: (options.hr ?? 140) + 8,
    });
  if (options.withDynamics)
    Object.assign(session, {
      avgStanceTime: 245,
      avgVerticalOscillation: 82,
      avgStepLength: 1150,
      avgVerticalRatio: 7.1,
    });
  enc.onMesg(SESSION, asMesg(session));
  enc.onMesg(
    ACTIVITY,
    asMesg({
      timestamp: end,
      numSessions: 1,
      type: "manual",
      event: "activity",
      eventType: "stop",
    }),
  );
  return enc.close();
}

let handle: TestDb;
const db = () => handle.db;

beforeAll(async () => {
  handle = await createTestDb();
  await handle.db.insert(schema.users).values([
    { id: USER_A, email: "a-activities@example.test", timezone: TZ },
    { id: USER_B, email: "b-activities@example.test", timezone: TZ },
    { id: USER_C, email: "c-activities@example.test", timezone: TZ },
    { id: USER_D, email: "d-activities@example.test", timezone: TZ },
  ]);
  await seedCatalog(handle.db);
  // A manual LTHR so zones can be derived once (spec §16, never 220 − age).
  await handle.db.insert(schema.athleteProfiles).values({ userId: USER_A, lthrManual: 170 });
});

afterAll(async () => {
  await handle.close();
});

describe("activityTitle / modalityForSport", () => {
  it("maps FIT sports to modalities and builds French titles", () => {
    expect(modalityForSport("running", "generic")).toBe("running");
    expect(modalityForSport("cycling", "indoor_cycling")).toBe("bike");
    expect(modalityForSport("fitness_equipment", "indoor_rowing")).toBe("row");
    expect(modalityForSport("training", null)).toBe("other");
    expect(activityTitle("running", null, 8213, 2700)).toBe("Course — 8.2 km");
    expect(activityTitle("cycling", "indoor_cycling", null, 2712)).toBe("Vélo — 45 min");
    expect(activityTitle("trail_running", null, 12400, 5000)).toBe("Trail — 12.4 km");
  });

  it("downsamples streams to at most 600 points without inventing values", () => {
    const values = Array.from({ length: 3000 }, (_, i) => (i % 7 === 0 ? null : i));
    const points = toStreamPoints(values, 1);
    expect(points.length).toBeLessThanOrEqual(600);
    expect(points[0]?.t).toBe(0);
    expect(toStreamPoints([null, null], 5).every((p) => p.v === null)).toBe(true);
  });
});

describe("importFitFile", () => {
  const bytes = buildRunFit({ start: "2026-09-29T07:15:00Z", durationSec: 600, speedMps: 3.1 });

  it("imports once and reports the second import of the same file as a duplicate", async () => {
    const first = await importFitFile(db(), userA, bytes, "run.fit");
    expect(first.duplicate).toBe(false);
    expect(first.merged).toBe(false);
    expect(first.activityId).toMatch(/^[0-9a-f-]{36}$/);

    const second = await importFitFile(db(), userA, bytes, "run.fit");
    expect(second.duplicate).toBe(true);
    expect(second.activityId).toBe(first.activityId);
    expect(second.workoutId).toBe(first.workoutId);

    const rows = await db()
      .select()
      .from(schema.activities)
      .where(eq(schema.activities.userId, USER_A));
    expect(rows).toHaveLength(1);
    const a = rows[0];
    if (!a) throw new Error("no activity");
    expect(a.provider).toBe("fit_import");
    expect(a.parserVersion).toBe(FIT_PARSER_VERSION);
    expect(a.localDate).toBe("2026-09-29"); // 07:15Z = 09:15 Paris
    expect(a.utcOffsetMin).toBe(120);
    expect(a.fingerprint).toBe(`running|${Math.floor(Date.parse("2026-09-29T07:15:00Z") / 60000)}`);
    expect(a.avgPaceSecKm).toBe(Math.round(1000 / 3.1));
    expect(a.comparableGroup).toBe("easy_run_flat_under45min");
    expect(a.zoneSetId).not.toBeNull();
    expect(a.timeInZones).not.toBeNull();
    expect(a.rawPayloadId).not.toBeNull();

    const raws = await db()
      .select()
      .from(schema.rawPayloads)
      .where(eq(schema.rawPayloads.userId, USER_A));
    expect(raws).toHaveLength(1);
    expect(raws[0]?.dedupeKey).toMatch(/^fit:[0-9a-f]{64}$/);
  });

  it("stores laps and the present streams with a derived pace (nulls kept)", async () => {
    const [a] = await db()
      .select()
      .from(schema.activities)
      .where(eq(schema.activities.userId, USER_A));
    if (!a) throw new Error("no activity");
    const laps = await db()
      .select()
      .from(schema.activityLaps)
      .where(eq(schema.activityLaps.activityId, a.id));
    expect(laps).toHaveLength(2);
    expect(laps.map((l) => l.lapIndex).sort()).toEqual([0, 1]);

    const streams = await db()
      .select()
      .from(schema.activityStreams)
      .where(eq(schema.activityStreams.activityId, a.id));
    const kinds = streams.map((s) => s.stream).sort();
    expect(kinds).toEqual(["altitude", "cadence", "distance", "hr", "pace", "speed"].sort());
    expect(kinds).not.toContain("power"); // never invented
    const pace = streams.find((s) => s.stream === "pace");
    const hr = streams.find((s) => s.stream === "hr");
    expect(pace?.values[3]).toBe(Math.round(1000 / 3.1));
    expect(pace?.sampleIntervalSec).toBe(5);
    expect(hr?.values[0]).toBeNull(); // first samples had no HR
    expect(hr?.count).toBe(hr?.values.length);
  });

  it("derives the zone set once from the manual LTHR and computes time in zones", async () => {
    const sets = await db()
      .select()
      .from(schema.hrZoneSets)
      .where(eq(schema.hrZoneSets.userId, USER_A));
    expect(sets).toHaveLength(1);
    expect(sets[0]?.method).toBe("lthr");
    expect(sets[0]?.lthr).toBe(170);
    // A hand-typed LTHR is declared, not measured: MEDIUM, never HIGH (spec §16, §70).
    expect(sets[0]?.source).toBe("USER");
    expect(sets[0]?.confidence).toBe("MEDIUM");
    const detail = await getActivityDetail(
      db(),
      USER_A,
      (await listActivities(db(), USER_A))[0]?.id ?? "",
    );
    expect(detail?.zones?.setId).toBe(sets[0]?.id);
    const tiz = detail?.zones?.timeInZones;
    if (!tiz) throw new Error("no time in zones");
    const total = tiz.z1 + tiz.z2 + tiz.z3 + tiz.z4 + tiz.z5;
    // 600 s at 5 s samples with the first 2 samples missing HR → ≈ 9.9 min, never more than 10.
    expect(total).toBeGreaterThan(9);
    expect(total).toBeLessThanOrEqual(10.1);
  });

  it("creates a done cardio workout with a LOW-confidence analysis when nothing was planned", async () => {
    const [a] = await db()
      .select()
      .from(schema.activities)
      .where(eq(schema.activities.userId, USER_A));
    if (!a?.workoutId) throw new Error("no linked workout");
    const [w] = await db()
      .select()
      .from(schema.workouts)
      .where(eq(schema.workouts.id, a.workoutId));
    expect(w?.type).toBe("cardio");
    expect(w?.source).toBe("fit_import");
    expect(w?.status).toBe("done");
    expect(w?.title).toBe("Course — 1.9 km");
    expect(w?.actualDurationMin).toBe(10);
    expect(w?.realisedIntensity).toBe("easy"); // avg HR 140 < 85 % of LTHR 170 → Z1
    expect(w?.intensitySource).toBe("CALCULATED");
    expect(w?.sessionRpeLoad).toBeNull(); // until the athlete gives an RPE
    const [c] = await db()
      .select()
      .from(schema.cardioWorkouts)
      .where(eq(schema.cardioWorkouts.workoutId, a.workoutId));
    expect(c?.modality).toBe("running");
    const [analysis] = await db()
      .select()
      .from(schema.workoutAnalyses)
      .where(
        and(
          eq(schema.workoutAnalyses.workoutId, a.workoutId),
          eq(schema.workoutAnalyses.phase, "actual"),
        ),
      );
    expect(analysis?.confidence).toBe("LOW");
    expect(analysis?.source).toBe("CALCULATED");
    expect(analysis?.intensity).toBe("easy");
    expect(analysis?.impactUnits).toBeCloseTo(1.86, 1); // measured km, not the default pace estimate
  });

  it("writes versioned computed metrics (EF) and exposes them with French labels", async () => {
    const [item] = await listActivities(db(), USER_A);
    if (!item) throw new Error("no activity");
    const detail = await getActivityDetail(db(), USER_A, item.id);
    const ef = detail?.metrics.find((m) => m.key === "efficiency_factor");
    expect(ef).toBeDefined();
    expect(ef?.label).toBe("Efficience aérobie (EF)");
    expect(ef?.unit).toBe("m/min/bpm");
    expect(ef?.algorithmVersion).toBe("efficiency_factor_v1");
    expect(ef?.estimated).toBe(true);
    // 10 min run: no decoupling (needs 40 min after warm-up) — never invented.
    expect(detail?.metrics.find((m) => m.key === "aerobic_decoupling")).toBeUndefined();
    expect(detail?.streams.hr?.length).toBeGreaterThan(0);
    expect(detail?.streams.pace?.length).toBeGreaterThan(0);
    expect(detail?.laps).toHaveLength(2);
    expect(detail?.workout?.id).toBe(item.workoutId);
  });

  it("links a planned cardio workout of the same day and scales its ACTUAL analysis", async () => {
    const date = "2026-09-30";
    const preset = CARDIO_PRESETS.run_easy_45;
    const [w] = await db()
      .insert(schema.workouts)
      .values({
        userId: USER_A,
        type: "cardio",
        source: "planned_user",
        status: "planned",
        date,
        plannedDurationMin: 45,
        title: preset.title,
        plannedIntensity: "easy",
        intensitySource: "USER",
        expectedRpe: 4,
      })
      .returning();
    if (!w) throw new Error("workout insert failed");
    await db().insert(schema.cardioWorkouts).values({
      userId: USER_A,
      workoutId: w.id,
      modality: "running",
      workoutKind: "zone2",
      steps: preset.steps,
    });
    await db()
      .insert(schema.workoutAnalyses)
      .values({
        userId: USER_A,
        workoutId: w.id,
        phase: "planned",
        date,
        ...analysisRowFromProfile(
          expectedLoadProfile(preset),
          "CALCULATED",
          CARDIO_BUILDER_ALGORITHM_VERSION,
          1,
          "run_easy_45",
        ),
      });

    const result = await importFitFile(
      db(),
      userA,
      buildRunFit({ start: `${date}T06:30:00Z`, durationSec: 1800, speedMps: 3.0, hr: 145 }),
      "footing.fit",
    );
    expect(result.duplicate).toBe(false);
    expect(result.workoutId).toBe(w.id);

    const [done] = await db().select().from(schema.workouts).where(eq(schema.workouts.id, w.id));
    expect(done?.status).toBe("done");
    expect(done?.actualDurationMin).toBe(30);
    // Measured from the zone distribution: 30 min around 145 bpm (85 % of LTHR 170) is Z1–Z2.
    expect(done?.realisedIntensity).toBe("easy");
    expect(done?.intensitySource).toBe("CALCULATED");
    expect(done?.finishedAt?.toISOString()).toBe(`${date}T07:00:00.000Z`);

    const [actual] = await db()
      .select()
      .from(schema.workoutAnalyses)
      .where(
        and(eq(schema.workoutAnalyses.workoutId, w.id), eq(schema.workoutAnalyses.phase, "actual")),
      );
    expect(actual?.confidence).toBe("MEDIUM");
    expect(actual?.source).toBe("CALCULATED");
    expect(actual?.algorithmVersion).toBe(
      `${CARDIO_BUILDER_ALGORITHM_VERSION}+${ACTUAL_SCALING_VERSION}`,
    );
    expect(actual?.stimulusCredits).toEqual(expectedLoadProfile(preset).expectedCredits); // credits kept
    expect(actual?.loadVector.cardiovascular).toBeLessThan(
      expectedLoadProfile(preset).loadVector.cardiovascular,
    ); // 30 min instead of 45 → scaled down

    const [a] = await db()
      .select()
      .from(schema.activities)
      .where(eq(schema.activities.id, result.activityId));
    expect(a?.workoutId).toBe(w.id);
    // No extra workout was created for this activity.
    const created = await db()
      .select()
      .from(schema.workouts)
      .where(and(eq(schema.workouts.userId, USER_A), eq(schema.workouts.date, date)));
    expect(created).toHaveLength(1);
  });

  async function planEasyRun(date: string) {
    const preset = CARDIO_PRESETS.run_easy_45;
    const [w] = await db()
      .insert(schema.workouts)
      .values({
        userId: USER_A,
        type: "cardio",
        source: "planned_user",
        status: "planned",
        date,
        plannedDurationMin: 45,
        title: preset.title,
        plannedIntensity: "easy",
        intensitySource: "USER",
        expectedRpe: 4,
      })
      .returning();
    if (!w) throw new Error("workout insert failed");
    await db().insert(schema.cardioWorkouts).values({
      userId: USER_A,
      workoutId: w.id,
      modality: "running",
      workoutKind: "zone2",
      steps: preset.steps,
    });
    await db()
      .insert(schema.workoutAnalyses)
      .values({
        userId: USER_A,
        workoutId: w.id,
        phase: "planned",
        date,
        ...analysisRowFromProfile(
          expectedLoadProfile(preset),
          "CALCULATED",
          CARDIO_BUILDER_ALGORITHM_VERSION,
          1,
          "run_easy_45",
        ),
      });
    return w;
  }

  it("classifies a Zone 2 plan run as a tempo from the measured HR zones (hard, CALCULATED)", async () => {
    const date = "2026-10-01";
    const w = await planEasyRun(date);
    // 20 min at ≈ 165 bpm = 97 % of LTHR 170 → Z4: ≥ 10 min in Z4–Z5, whatever the plan said.
    const result = await importFitFile(
      db(),
      userA,
      buildRunFit({ start: `${date}T06:30:00Z`, durationSec: 1200, speedMps: 3.3, hr: 165 }),
      "tempo.fit",
    );
    expect(result.workoutId).toBe(w.id);
    const [done] = await db().select().from(schema.workouts).where(eq(schema.workouts.id, w.id));
    expect(done?.status).toBe("done");
    expect(done?.plannedIntensity).toBe("easy");
    expect(done?.realisedIntensity).toBe("hard");
    expect(done?.intensitySource).toBe("CALCULATED");
    const [actual] = await db()
      .select()
      .from(schema.workoutAnalyses)
      .where(
        and(eq(schema.workoutAnalyses.workoutId, w.id), eq(schema.workoutAnalyses.phase, "actual")),
      );
    expect(actual?.intensity).toBe("hard"); // the engine counts it in hardDone6d
    const [a] = await db()
      .select()
      .from(schema.activities)
      .where(eq(schema.activities.id, result.activityId));
    expect(a?.comparableGroup).toMatch(/^hard_run_/); // activity chip and workout agree
  });

  it("keeps the planned band and its declared source when the activity has no HR", async () => {
    const date = "2026-10-02";
    const w = await planEasyRun(date);
    const result = await importFitFile(
      db(),
      userA,
      buildRunFit({ start: `${date}T06:30:00Z`, durationSec: 1200, speedMps: 3.3, hr: null }),
      "no-hr.fit",
    );
    expect(result.workoutId).toBe(w.id);
    const [done] = await db().select().from(schema.workouts).where(eq(schema.workouts.id, w.id));
    expect(done?.realisedIntensity).toBe("easy"); // nothing measured → the plan's band …
    expect(done?.intensitySource).toBe("USER"); // … with the plan's source, never "CALCULATED"
  });

  it("stores a versioned pace @ HR metric (Z2 band of the zone set) for a steady easy run", async () => {
    const date = "2026-10-07";
    const result = await importFitFile(
      db(),
      userA,
      buildRunFit({ start: `${date}T06:30:00Z`, durationSec: 1200, speedMps: 2.9, hr: 148 }),
      "steady.fit",
    );
    const detail = await getActivityDetail(db(), USER_A, result.activityId);
    const m = detail?.metrics.find((x) => x.key === "pace_at_hr");
    expect(m).toBeDefined();
    expect(m?.label).toBe("Allure à FC (zone 2)");
    expect(m?.unit).toBe("s/km");
    expect(m?.value).toBe(Math.round(1000 / 2.9)); // constant speed → the band's pace is the pace
    expect(m?.algorithmVersion).toBe("pace_at_hr_v1");
    expect(m?.estimated).toBe(true);
    expect(m?.detail).toContain("145–152 bpm"); // Z2 of LTHR 170 = 85–89 %
    const [row] = await db()
      .select()
      .from(schema.computedMetrics)
      .where(
        and(
          eq(schema.computedMetrics.userId, USER_A),
          eq(schema.computedMetrics.metric, "pace_at_hr"),
          eq(schema.computedMetrics.scopeId, result.activityId),
        ),
      );
    expect(row?.inputs).toMatchObject({ zone: 2, hrMin: 145, hrMax: 152 });
    expect(row?.superseded).toBe(false);
  });

  it("detects running PRs (5 km) and supersedes the previous record", async () => {
    const first = await importFitFile(
      db(),
      userA,
      buildRunFit({ start: "2026-10-03T07:00:00Z", durationSec: 1560, speedMps: 5200 / 1560 }),
      "5k.fit",
    );
    // 5.2 km > 1 % over the distance: the time is pro-rated, announced as an estimate (spec §70).
    expect(first.prs).toEqual(["≈ Record estimé sur 5 km : 25:00 (au prorata de 5,2 km)"]);

    const slower = await importFitFile(
      db(),
      userA,
      buildRunFit({ start: "2026-10-04T07:00:00Z", durationSec: 1620, speedMps: 5000 / 1620 }),
      "5k-slow.fit",
    );
    expect(slower.prs).toEqual([]);

    const faster = await importFitFile(
      db(),
      userA,
      buildRunFit({ start: "2026-10-05T07:00:00Z", durationSec: 1479, speedMps: 5100 / 1479 }),
      "5k-fast.fit",
    );
    expect(faster.prs).toEqual(["≈ Record estimé sur 5 km : 24:10 (au prorata de 5,1 km)"]);

    const prs = await db()
      .select()
      .from(schema.personalRecords)
      .where(
        and(
          eq(schema.personalRecords.userId, USER_A),
          eq(schema.personalRecords.kind, "time"),
          eq(schema.personalRecords.distanceKey, "5k"),
        ),
      );
    // The 30-min linked footing (5.4 km, 27:47) set the first 5 km record; two improvements since.
    expect(prs).toHaveLength(3);
    const current = prs.filter((p) => !p.superseded);
    expect(current).toHaveLength(1);
    expect(current[0]?.value).toBe(1450);
    expect(current[0]?.previousValue).toBe(1500);
    expect(current[0]?.estimated).toBe(true); // pro-rated from 5.1 km
    expect(current[0]?.activityId).toBe(faster.activityId);
    const previous = prs.find((p) => p.value === 1500);
    expect(previous?.superseded).toBe(true);
    expect(previous?.activityId).toBe(first.activityId);
    expect(current[0]?.algorithmVersion).toBe("run_pr_prorata_v1");

    // Exactly 5 km: a real record, announced without "≈".
    const exact = await importFitFile(
      db(),
      userA,
      buildRunFit({ start: "2026-10-06T07:00:00Z", durationSec: 1440, speedMps: 5000 / 1440 }),
      "5k-exact.fit",
    );
    expect(exact.prs).toEqual(["Nouveau record 5 km : 24:00"]);
    const [exactRow] = await db()
      .select()
      .from(schema.personalRecords)
      .where(eq(schema.personalRecords.activityId, exact.activityId));
    expect(exactRow?.estimated).toBe(false);
    expect(exactRow?.source).toBe("DEVICE");
  });

  it("rejects bytes that are not a FIT file with the parser's own message", async () => {
    await expect(
      importFitFile(
        db(),
        userA,
        new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]),
        "x.fit",
      ),
    ).rejects.toBeInstanceOf(InvalidFitError);
    await expect(
      importFitFile(
        db(),
        userA,
        new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]),
        "x.fit",
      ),
    ).rejects.toThrow(/Not a FIT/);
  });
});

describe("syncGarminActivities", () => {
  const mock = new GarminMockProvider();
  const range = { from: "2026-09-21T00:00:00Z", to: "2026-09-27T23:59:59Z" }; // Mon → Sun

  it("throws FeatureDisabledError when the flag is off", async () => {
    await expect(
      syncGarminActivities(db(), userB, range, { enabled: false, provider: mock }),
    ).rejects.toBeInstanceOf(FeatureDisabledError);
  });

  it("imports the mock fixtures once, then reports them as duplicates", async () => {
    const first = await syncGarminActivities(db(), userB, range, {
      enabled: true,
      provider: mock,
    });
    expect(first.imported).toBe(4); // Tue run, Thu intervals, Sat long run, Sun indoor bike
    expect(first.duplicates).toBe(0);

    const second = await syncGarminActivities(db(), userB, range, {
      enabled: true,
      provider: mock,
    });
    expect(second.imported).toBe(0);
    expect(second.duplicates).toBe(4);

    const items = await listActivities(db(), USER_B);
    expect(items).toHaveLength(4);
    // Simulated data is always recognisable: never stored as plain `garmin` (spec §14, §70).
    expect(items.every((i) => i.provider === "garmin_mock")).toBe(true);
    expect(items.every((i) => i.workoutId !== null)).toBe(true);
    const bike = items.find((i) => i.modality === "bike");
    expect(bike?.title).toMatch(/^Vélo — \d+ min$/);
    expect(bike?.comparableGroup).toMatch(/^easy_bike_indoor_/); // sub-sport indoor_cycling

    const raws = await db()
      .select()
      .from(schema.rawPayloads)
      .where(eq(schema.rawPayloads.userId, USER_B));
    expect(raws).toHaveLength(4);
    expect(raws.every((r) => r.provider === "garmin_mock")).toBe(true);
    expect(raws.every((r) => r.dedupeKey.startsWith("garmin:activity:"))).toBe(true);
    expect(raws.every((r) => r.parserVersion === GARMIN_IMPORT_VERSION)).toBe(true);

    // Simulated data never enters the PR ledger or the test log — nothing celebrated, nothing
    // that could later retire a measured record (spec §14, §70, ADR-023).
    expect(first.prs).toEqual([]);
    const prs = await db()
      .select({ source: schema.personalRecords.source })
      .from(schema.personalRecords)
      .where(eq(schema.personalRecords.userId, USER_B));
    expect(prs).toHaveLength(0);
    const tests = await db()
      .select({ id: schema.testResults.id })
      .from(schema.testResults)
      .where(eq(schema.testResults.userId, USER_B));
    expect(tests).toHaveLength(0);
  });

  it("stores no realised intensity for an unmatched activity when no zone was resolved", async () => {
    // User B has no LTHR and no zone set: nothing was calculated, so nothing is claimed (spec §70).
    const ws = await db()
      .select({
        realisedIntensity: schema.workouts.realisedIntensity,
        intensitySource: schema.workouts.intensitySource,
        source: schema.workouts.source,
        status: schema.workouts.status,
      })
      .from(schema.workouts)
      .where(eq(schema.workouts.userId, USER_B));
    expect(ws).toHaveLength(4);
    expect(ws.every((w) => w.status === "done")).toBe(true);
    expect(ws.every((w) => w.realisedIntensity === null)).toBe(true);
    expect(ws.every((w) => w.intensitySource === "CALCULATED")).toBe(true);
    expect(ws.every((w) => w.source === "garmin")).toBe(true); // `workout_source` enum: no mock value
  });

  it("computes aerobic decoupling on the long run and running dynamics from HRM streams", async () => {
    const items = await listActivities(db(), USER_B);
    const longRun = items.find((i) => i.modality === "running" && i.durationSec > 80 * 60);
    if (!longRun) throw new Error("no long run");
    const detail = await getActivityDetail(db(), USER_B, longRun.id);
    const keys = detail?.metrics.map((m) => m.key) ?? [];
    expect(keys).toContain("aerobic_decoupling");
    expect(keys).toContain("efficiency_factor");
    expect(keys).toContain("rd_gct");
    expect(keys).toContain("rd_stride_length");
    expect(detail?.metrics.find((m) => m.key === "aerobic_decoupling")?.algorithmVersion).toBe(
      "aerobic_decoupling_v1",
    );
    expect(detail?.activity.runningDynamics?.avgGctMs).toBe(245);
    expect(detail?.streams.hr?.length ?? 0).toBeLessThanOrEqual(600);
    // Garmin fixtures have no zone set for user B (no LTHR): honest "no zones", not 220 − age.
    expect(detail?.zones).toBeNull();
  });
});

/** A planned "Test 5 km" (preset) on `date`: `linkPlannedWorkout` matches it by date + modality. */
async function planTest5k(userId: string, date: string) {
  const preset = CARDIO_PRESETS.test_run_5k;
  const [w] = await db()
    .insert(schema.workouts)
    .values({
      userId,
      type: "cardio",
      source: "planned_user",
      status: "planned",
      date,
      plannedDurationMin: 45,
      title: preset.title,
      plannedIntensity: "hard",
      intensitySource: "USER",
      expectedRpe: 9,
    })
    .returning();
  if (!w) throw new Error("workout insert failed");
  await db().insert(schema.cardioWorkouts).values({
    userId,
    workoutId: w.id,
    modality: preset.modality,
    workoutKind: preset.kind,
    steps: preset.steps,
  });
  return w;
}

describe("recordTest5k (spec §57, §70)", () => {
  const testRows = (userId: string) =>
    db()
      .select()
      .from(schema.testResults)
      .where(
        and(eq(schema.testResults.userId, userId), eq(schema.testResults.testKey, "test_run_5k")),
      )
      .orderBy(schema.testResults.date);

  it("uses the PR detector's boundaries: exact ≤ 1 % over, pro-rated estimate beyond, nothing beyond 15 %", async () => {
    const w1 = await planTest5k(USER_C, "2026-11-02");
    const w2 = await planTest5k(USER_C, "2026-11-03");
    const w3 = await planTest5k(USER_C, "2026-11-04");

    // 5.05 km in 25:00 — within 1 % of the distance: the time is the test itself.
    const near = await importFitFile(
      db(),
      userC,
      buildRunFit({ start: "2026-11-02T07:00:00Z", durationSec: 1500, speedMps: 5050 / 1500 }),
      "test-5k-505.fit",
    );
    expect(near.workoutId).toBe(w1.id);
    // 5.12 km in 25:00 — beyond 1 %: pro-rated, i.e. an estimate the athlete never ran.
    const over = await importFitFile(
      db(),
      userC,
      buildRunFit({ start: "2026-11-03T07:00:00Z", durationSec: 1500, speedMps: 5120 / 1500 }),
      "test-5k-512.fit",
    );
    expect(over.workoutId).toBe(w2.id);
    // 8 km (warm-up + test + cool-down recorded as one activity): the average pace says nothing
    // about the 5 km — no test is invented from it.
    const whole = await importFitFile(
      db(),
      userC,
      buildRunFit({ start: "2026-11-04T07:00:00Z", durationSec: 2400, speedMps: 8000 / 2400 }),
      "test-5k-whole-session.fit",
    );
    expect(whole.workoutId).toBe(w3.id); // still linked and done, just no test result

    const rows = await testRows(USER_C);
    expect(rows).toHaveLength(2);
    const [exact, estimated] = rows;
    expect(exact).toMatchObject({
      date: "2026-11-02",
      value: Math.round((1500 * 5000) / 5050),
      unit: "s",
      source: "DEVICE",
      confidence: "HIGH",
      algorithmVersion: null,
      activityId: near.activityId,
      workoutId: w1.id,
    });
    expect(exact?.conditions).toMatchObject({ distanceM: 5050 });
    expect(estimated).toMatchObject({
      date: "2026-11-03",
      value: Math.round((1500 * 5000) / 5120),
      source: "DEVICE",
      confidence: "MEDIUM",
      algorithmVersion: RUN_PR_ALGORITHM_VERSION,
      activityId: over.activityId,
      workoutId: w2.id,
    });
    expect(rows.some((r) => r.activityId === whole.activityId)).toBe(false);

    // The PR written from the very same runs agrees with the test's exact/estimated verdict.
    const prs = await db()
      .select({
        activityId: schema.personalRecords.activityId,
        estimated: schema.personalRecords.estimated,
      })
      .from(schema.personalRecords)
      .where(
        and(
          eq(schema.personalRecords.userId, USER_C),
          eq(schema.personalRecords.distanceKey, "5k"),
        ),
      );
    expect(prs.find((p) => p.activityId === near.activityId)?.estimated).toBe(false);
    expect(prs.find((p) => p.activityId === over.activityId)?.estimated).toBe(true);
    expect(prs.some((p) => p.activityId === whole.activityId)).toBe(false);
  });
});

describe("simulated provenance (garmin_mock)", () => {
  it("never lets a simulated run set or supersede a measured record, nor log a test", async () => {
    const date = "2026-11-05";
    // A measured 5 km record (25:00) and a planned "Test 5 km" that the mock run will be linked to.
    await db()
      .insert(schema.personalRecords)
      .values({
        userId: USER_D,
        kind: "time",
        distanceKey: "5k",
        value: 1500,
        unit: "s",
        achievedAt: new Date("2026-10-20T07:00:00Z"),
        source: "DEVICE",
      });
    const w = await planTest5k(USER_D, date);

    // A simulated 5.05 km in 23:20 — faster than the measured record.
    const result = await importActivityDetails(
      db(),
      userD,
      {
        externalId: `mock-${date}-running`,
        sport: "running",
        subSport: null,
        startTime: `${date}T07:10:00+01:00`,
        utcOffsetSec: 3600,
        durationSec: 1400,
        distanceM: 5050,
        avgHr: 172,
        maxHr: 184,
        avgSpeedMps: 5050 / 1400,
        raw: { source: "mock", date, sport: "running" },
        laps: [],
        streams: { sampleIntervalSec: 5 },
      },
      {
        provider: "garmin_mock",
        dedupeKey: `garmin:activity:mock-${date}-running`,
        parserVersion: GARMIN_IMPORT_VERSION,
        rawKind: "activity",
      },
    );
    expect(result.duplicate).toBe(false);
    // Still importable, visible and linked to the day's plan (spec §14) …
    expect(result.workoutId).toBe(w.id);
    const [a] = await db()
      .select({ provider: schema.activities.provider, workoutId: schema.activities.workoutId })
      .from(schema.activities)
      .where(eq(schema.activities.id, result.activityId));
    expect(a).toEqual({ provider: "garmin_mock", workoutId: w.id });
    // … but nothing is celebrated, nothing enters the ledger and the measured record stays current.
    expect(result.prs).toEqual([]);
    const prs = await db()
      .select()
      .from(schema.personalRecords)
      .where(eq(schema.personalRecords.userId, USER_D));
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      source: "DEVICE",
      value: 1500,
      superseded: false,
      previousValue: null,
    });
    const tests = await db()
      .select({ id: schema.testResults.id })
      .from(schema.testResults)
      .where(eq(schema.testResults.userId, USER_D));
    expect(tests).toHaveLength(0);
  });
});

describe("ownership isolation", () => {
  it("never shows another user's activity", async () => {
    const [a] = await listActivities(db(), USER_A);
    if (!a) throw new Error("no activity");
    expect(await getActivityDetail(db(), USER_B, a.id)).toBeNull();
    const bItems = await listActivities(db(), USER_B);
    expect(bItems.some((i) => i.id === a.id)).toBe(false);
    const aItems = await listActivities(db(), USER_A);
    expect(aItems.every((i) => i.provider === "fit_import")).toBe(true);
  });
});
