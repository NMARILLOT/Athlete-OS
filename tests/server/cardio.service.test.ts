import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "@/db/test-db";
import {
  CARDIO_BUILDER_ALGORITHM_VERSION,
  CARDIO_PRESETS,
  expectedLoadProfile,
} from "@/domain/cardio";
import { getCatalogEntry, type Option } from "@/domain/engine";
import { NotFoundError, ValidationError } from "@/server/errors";
import { FeatureDisabledError } from "@/server/flags";
import { GarminMockProvider } from "@/server/providers/garmin/mock";
import { GarminOfficialProvider } from "@/server/providers/garmin/official";
import type { GarminProvider } from "@/server/providers/garmin/types";
import {
  completeCardio,
  createCardioWorkout,
  getCardioWorkout,
  guessModalityFromTitle,
  resolveZoneSet,
  sendToGarmin,
  startCardioWorkout,
  updateCardioSpec,
} from "@/server/services/cardio.service";
import { createWorkoutFromOption } from "@/server/services/workout.service";

vi.mock("server-only", () => ({}));

/**
 * Cardio service on PGlite: preset creation and its CALCULATED analysis, lazy materialisation of
 * engine-created workouts, versioned zones from a manual LTHR, the Garmin push state machine
 * (mock / failing / disabled), spec edits, start / finish, and ownership isolation.
 */
const USER_A = "00000000-0000-4000-8000-0000000000a1";
const USER_B = "00000000-0000-4000-8000-0000000000b1";
const TZ = "Europe/Paris";
const TODAY = "2026-09-28";

let handle: TestDb;
const mock = new GarminMockProvider();
const garminOn = { enabled: true, provider: mock };
const garminOff = { enabled: false, provider: mock };

/** A provider whose every call blows up (network down, bad credentials, …). */
class ExplodingProvider implements GarminProvider {
  readonly name = "official" as const;
  async isConnected(): Promise<boolean> {
    return true;
  }
  async getActivities(): Promise<never> {
    throw new Error("boom");
  }
  async getActivity(): Promise<never> {
    throw new Error("boom");
  }
  async getHealthData(): Promise<never> {
    throw new Error("boom");
  }
  async createWorkout(): Promise<never> {
    throw new Error("socket hang up (token=secret)");
  }
  async scheduleWorkout(): Promise<never> {
    throw new Error("boom");
  }
  async disconnect(): Promise<void> {}
}

let thresholdId = "";

async function cardioRow(workoutId: string) {
  return handle.db
    .select()
    .from(schema.cardioWorkouts)
    .where(eq(schema.cardioWorkouts.workoutId, workoutId));
}

async function workoutRow(workoutId: string) {
  const [w] = await handle.db
    .select()
    .from(schema.workouts)
    .where(eq(schema.workouts.id, workoutId))
    .limit(1);
  return w ?? null;
}

async function analysisRow(workoutId: string, phase: "planned" | "actual") {
  const [a] = await handle.db
    .select()
    .from(schema.workoutAnalyses)
    .where(
      and(eq(schema.workoutAnalyses.workoutId, workoutId), eq(schema.workoutAnalyses.phase, phase)),
    )
    .limit(1);
  return a ?? null;
}

beforeAll(async () => {
  handle = await createTestDb();
  await handle.db.insert(schema.users).values([
    { id: USER_A, email: "a-cardio@example.test" },
    { id: USER_B, email: "b-cardio@example.test" },
  ]);
});

afterAll(async () => {
  await handle.close();
});

describe("cardio service", () => {
  it("creates a preset workout with its spec row and a CALCULATED planned analysis", async () => {
    const spec = CARDIO_PRESETS.run_threshold;
    const { id } = await createCardioWorkout(handle.db, USER_A, {
      date: TODAY,
      startMinute: 18 * 60,
      timezone: TZ,
      spec,
      presetKind: "run_threshold",
    });
    thresholdId = id;

    const w = await workoutRow(id);
    expect(w).toMatchObject({
      userId: USER_A,
      type: "cardio",
      source: "planned_user",
      status: "planned",
      date: TODAY,
      title: "Seuil — 3 × 8 min",
      plannedDurationMin: 50,
      plannedIntensity: "hard",
      intensitySource: "CALCULATED",
      expectedRpe: 8,
      fixed: false,
    });
    // 18:00 Paris (CEST) = 16:00 UTC.
    expect(w?.startAt?.toISOString()).toBe("2026-09-28T16:00:00.000Z");

    const [c] = await cardioRow(id);
    expect(c).toMatchObject({
      userId: USER_A,
      modality: "running",
      workoutKind: "threshold",
      garminSyncStatus: "not_sent",
      garminWorkoutId: null,
      zoneSetId: null,
    });
    expect(c?.steps).toEqual(spec.steps);

    const expected = expectedLoadProfile(spec);
    const planned = await analysisRow(id, "planned");
    expect(planned).toMatchObject({
      userId: USER_A,
      date: TODAY,
      source: "CALCULATED",
      algorithmVersion: CARDIO_BUILDER_ALGORITHM_VERSION,
      confidence: "HIGH",
      inputRef: "run_threshold",
      intensity: "hard",
      heavyStrength: false,
      stimulusCredits: { threshold: 1 },
    });
    expect(planned?.loadVector).toEqual(expected.loadVector);
    expect(planned?.impactUnits).toBeCloseTo(expected.impactUnits, 3);
    expect(planned?.patternExposure).toEqual(expected.patterns);
  });

  it("rejects an invalid spec before touching the database", async () => {
    const before = await handle.db.select().from(schema.workouts);
    await expect(
      createCardioWorkout(handle.db, USER_A, {
        date: TODAY,
        startMinute: null,
        timezone: TZ,
        spec: { modality: "running", kind: "zone2", title: "x", steps: [] },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    const after = await handle.db.select().from(schema.workouts);
    expect(after).toHaveLength(before.length);
  });

  it("renders the flattened steps with French labels, without zones until they exist", async () => {
    const view = await getCardioWorkout(handle.db, USER_A, thresholdId, {
      timezone: TZ,
      garmin: garminOff,
    });
    expect(view).not.toBeNull();
    expect(view?.title).toBe("Seuil — 3 × 8 min");
    expect(view?.modalityLabel).toBe("Course");
    expect(view?.kindLabel).toBe("Seuil");
    expect(view?.startMinute).toBe(18 * 60);
    expect(view?.estimatedMin).toBe(50);
    expect(view?.flatSteps).toHaveLength(8);
    expect(view?.flatSteps[0]).toMatchObject({
      index: 1,
      kind: "warmup",
      kindLabel: "Échauffement",
      extentLabel: "10 min",
      targetLabel: "Z1",
    });
    expect(view?.flatSteps[1]).toMatchObject({
      kind: "work",
      targetLabel: "Z4",
      extentLabel: "8 min",
    });
    expect(view?.flatSteps[2]).toMatchObject({
      kind: "recovery",
      kindLabel: "Récup",
      notes: "trot facile",
    });
    expect(view?.expectedLoad).toMatchObject({
      intensity: "hard",
      intensityLabel: "dure",
      durationMin: 50,
      estimated: true,
      credits: [{ key: "threshold", label: "seuil", value: 1 }],
    });
    expect(view?.expectedLoad.vector.map((d) => d.key)).toEqual([
      "cardiovascular",
      "muscular_lower",
      "muscular_upper",
      "impact",
      "eccentric",
      "technical",
    ]);
    expect(view?.zoneSet).toBeNull();
    expect(view?.garmin).toMatchObject({
      status: "not_sent",
      workoutId: null,
      enabled: false,
      connected: false,
      providerName: "mock",
    });
  });

  it("materialises the cardio row of an engine-created workout from the catalog preset, once", async () => {
    const entry = getCatalogEntry("run_easy_45");
    if (!entry) throw new Error("catalog entry missing");
    const option: Option = {
      kind: entry.kind,
      family: entry.family,
      title: entry.title,
      origin: "catalog",
      score: 1,
      reason: "test",
      expectedCredits: entry.expectedCredits,
      loadVector: entry.loadVector,
      intensity: entry.intensity,
      heavyStrength: false,
      durationMin: entry.durationMin,
      modality: entry.modality,
      patterns: entry.patterns,
      impactUnits: entry.impactUnits ?? 0,
    };
    const created = await createWorkoutFromOption(handle.db, USER_A, {
      option,
      date: TODAY,
      timezone: TZ,
      recommendationId: null,
      startMinute: 9 * 60,
    });
    expect(created.type).toBe("cardio");
    expect(await cardioRow(created.id)).toHaveLength(0);

    const view = await getCardioWorkout(handle.db, USER_A, created.id, {
      timezone: TZ,
      garmin: garminOff,
    });
    expect(view?.spec).toEqual({
      modality: "running",
      kind: "zone2",
      title: entry.title,
      steps: CARDIO_PRESETS.run_easy_45.steps,
    });
    expect(view?.estimatedMin).toBe(45);
    expect(view?.flatSteps[0]?.targetLabel).toBe("Z2");

    await getCardioWorkout(handle.db, USER_A, created.id, { timezone: TZ, garmin: garminOff });
    const rows = await cardioRow(created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ modality: "running", workoutKind: "zone2" });
    // The engine's own planned analysis is kept as is.
    expect(await analysisRow(created.id, "planned")).toMatchObject({
      source: "ENGINE",
      inputRef: "run_easy_45",
    });
  });

  it("falls back to one open step of the planned duration when no preset applies", async () => {
    const [w] = await handle.db
      .insert(schema.workouts)
      .values({
        userId: USER_A,
        type: "cardio",
        source: "planned_engine",
        date: TODAY,
        title: "Vélo tranquille",
        plannedDurationMin: 40,
      })
      .returning({ id: schema.workouts.id });
    if (!w) throw new Error("insert failed");
    const view = await getCardioWorkout(handle.db, USER_A, w.id, {
      timezone: TZ,
      garmin: garminOff,
    });
    expect(view?.spec).toEqual({
      modality: "bike",
      kind: "free",
      title: "Vélo tranquille",
      steps: [{ kind: "work", durationSec: 2400, target: { type: "open" } }],
    });
    expect(view?.flatSteps).toEqual([
      expect.objectContaining({ kindLabel: "Effort", extentLabel: "40 min", targetLabel: "libre" }),
    ]);
    expect(view?.estimatedMin).toBe(40);
    expect(guessModalityFromTitle("Row — 30 min")).toBe("row");
    expect(guessModalityFromTitle("Walk — 45 min")).toBe("walking");
    expect(guessModalityFromTitle("Session")).toBe("other");
  });

  it("derives zones from the manual LTHR once and renders bpm bounds on targets", async () => {
    expect(await resolveZoneSet(handle.db, USER_A, TODAY)).toBeNull();
    await handle.db.insert(schema.athleteProfiles).values({ userId: USER_A, lthrManual: 170 });

    const first = await resolveZoneSet(handle.db, USER_A, TODAY);
    expect(first).toMatchObject({ method: "lthr", source: "USER", confidence: "HIGH", lthr: 170 });
    expect(first?.zones.map((z) => [z.minBpm, z.maxBpm])).toEqual([
      [0, 144],
      [145, 152],
      [153, 161],
      [162, 169],
      [170, 250],
    ]);
    // Same LTHR, earlier date: the stored set is reused, never re-derived.
    const again = await resolveZoneSet(handle.db, USER_A, "2026-09-01");
    expect(again?.id).toBe(first?.id);
    const stored = await handle.db
      .select()
      .from(schema.hrZoneSets)
      .where(eq(schema.hrZoneSets.userId, USER_A));
    expect(stored).toHaveLength(1);

    const view = await getCardioWorkout(handle.db, USER_A, thresholdId, {
      timezone: TZ,
      garmin: garminOff,
    });
    expect(view?.zoneSet?.id).toBe(first?.id);
    expect(view?.flatSteps[0]?.targetLabel).toBe("Z1 (≤ 144 bpm)");
    expect(view?.flatSteps[1]?.targetLabel).toBe("Z4 (162–169 bpm)");
    const [c] = await cardioRow(thresholdId);
    expect(c?.zoneSetId).toBe(first?.id);

    // Zones stay isolated per athlete.
    expect(await resolveZoneSet(handle.db, USER_B, TODAY)).toBeNull();
  });

  it("sends to Garmin through the mock provider and stores synced + the scheduled date", async () => {
    const res = await sendToGarmin(handle.db, USER_A, thresholdId, garminOn);
    expect(res).toMatchObject({
      status: "synced",
      scheduledFor: TODAY,
      lastError: null,
      enabled: true,
      connected: true,
      providerName: "mock",
    });
    expect(res.workoutId).toMatch(/^mock-wk-threshold-/);
    const [c] = await cardioRow(thresholdId);
    expect(c).toMatchObject({
      garminSyncStatus: "synced",
      garminWorkoutId: res.workoutId,
      garminScheduledFor: TODAY,
      lastSyncError: null,
    });
  });

  it("stores failed with a message and keeps everything when the provider throws", async () => {
    const res = await sendToGarmin(handle.db, USER_A, thresholdId, {
      enabled: true,
      provider: new ExplodingProvider(),
    });
    expect(res.status).toBe("failed");
    expect(res.lastError).toMatch(/Garmin/);
    expect(res.lastError).not.toMatch(/secret/);
    const [c] = await cardioRow(thresholdId);
    expect(c?.garminSyncStatus).toBe("failed");
    expect(c?.steps).toEqual(CARDIO_PRESETS.run_threshold.steps);
    expect(await workoutRow(thresholdId)).toMatchObject({ status: "planned" });
    expect(await analysisRow(thresholdId, "planned")).not.toBeNull();

    // The official stub degrades explicitly with its NotConfigured message.
    const stub = await sendToGarmin(handle.db, USER_A, thresholdId, {
      enabled: true,
      provider: new GarminOfficialProvider(),
    });
    expect(stub.status).toBe("failed");
    expect(stub.lastError).toMatch(/n'est pas configuré/);
    expect(stub.connected).toBe(false);
  });

  it("refuses to push when the Garmin flag is off and leaves the row untouched", async () => {
    await expect(sendToGarmin(handle.db, USER_A, thresholdId, garminOff)).rejects.toBeInstanceOf(
      FeatureDisabledError,
    );
    const [c] = await cardioRow(thresholdId);
    expect(c?.garminSyncStatus).toBe("failed");
  });

  it("re-runs the analysis on a spec change and resets a stale Garmin sync", async () => {
    await sendToGarmin(handle.db, USER_A, thresholdId, garminOn);
    expect((await cardioRow(thresholdId))[0]?.garminSyncStatus).toBe("synced");

    await updateCardioSpec(handle.db, USER_A, thresholdId, CARDIO_PRESETS.run_easy_60);
    expect(await workoutRow(thresholdId)).toMatchObject({
      title: "Footing Z2 — 60 min",
      plannedDurationMin: 60,
      plannedIntensity: "easy",
      expectedRpe: 4,
      status: "planned",
    });
    const [c] = await cardioRow(thresholdId);
    expect(c).toMatchObject({
      workoutKind: "zone2",
      garminSyncStatus: "not_sent",
      garminWorkoutId: null,
      garminScheduledFor: null,
      lastSyncError: null,
    });
    const planned = await analysisRow(thresholdId, "planned");
    expect(planned).toMatchObject({
      intensity: "easy",
      stimulusCredits: { aerobic_easy: 1 },
      algorithmVersion: CARDIO_BUILDER_ALGORITHM_VERSION,
      inputRef: "run_threshold",
    });
    expect(planned?.loadVector).toEqual(expectedLoadProfile(CARDIO_PRESETS.run_easy_60).loadVector);

    // A title-only change keeps the sync state.
    await sendToGarmin(handle.db, USER_A, thresholdId, garminOn);
    await updateCardioSpec(handle.db, USER_A, thresholdId, {
      ...CARDIO_PRESETS.run_easy_60,
      title: "Footing du dimanche",
    });
    expect((await cardioRow(thresholdId))[0]?.garminSyncStatus).toBe("synced");
    expect((await workoutRow(thresholdId))?.title).toBe("Footing du dimanche");
  });

  it("never exposes or mutates another athlete's workout", async () => {
    expect(
      await getCardioWorkout(handle.db, USER_B, thresholdId, { timezone: TZ, garmin: garminOff }),
    ).toBeNull();
    await expect(
      updateCardioSpec(handle.db, USER_B, thresholdId, CARDIO_PRESETS.run_easy_45),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(sendToGarmin(handle.db, USER_B, thresholdId, garminOn)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(startCardioWorkout(handle.db, USER_B, thresholdId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      completeCardio(handle.db, USER_B, {
        workoutId: thresholdId,
        rpe: 5,
        feeling: "good",
        painReported: false,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await workoutRow(thresholdId)).toMatchObject({ userId: USER_A, status: "planned" });
  });

  it("starts, then finishes with the elapsed time as the actual duration", async () => {
    const start = new Date("2026-09-28T16:05:00.000Z");
    await startCardioWorkout(handle.db, USER_A, thresholdId, start);
    expect(await workoutRow(thresholdId)).toMatchObject({ status: "in_progress", startAt: start });
    // Idempotent: a second tap does not move the clock.
    await startCardioWorkout(handle.db, USER_A, thresholdId, new Date(start.getTime() + 60_000));
    expect((await workoutRow(thresholdId))?.startAt).toEqual(start);
    await expect(
      updateCardioSpec(handle.db, USER_A, thresholdId, CARDIO_PRESETS.run_easy_45),
    ).rejects.toBeInstanceOf(ValidationError);

    const res = await completeCardio(handle.db, USER_A, {
      workoutId: thresholdId,
      rpe: 7,
      feeling: "good",
      painReported: false,
      now: new Date(start.getTime() + 47 * 60_000),
    });
    expect(res.actualDurationMin).toBe(47);
    expect(await workoutRow(thresholdId)).toMatchObject({
      status: "done",
      actualDurationMin: 47,
      rpe: 7,
      feeling: "good",
      sessionRpeLoad: 329,
    });
    expect(await analysisRow(thresholdId, "actual")).toMatchObject({ source: "CALCULATED" });
    await expect(sendToGarmin(handle.db, USER_A, thresholdId, garminOn)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("finishing without starting records the planned duration", async () => {
    const { id } = await createCardioWorkout(handle.db, USER_A, {
      date: TODAY,
      startMinute: null,
      timezone: TZ,
      spec: CARDIO_PRESETS.row_easy_30,
      presetKind: "row_easy_30",
    });
    const res = await completeCardio(handle.db, USER_A, {
      workoutId: id,
      rpe: 4,
      feeling: "great",
      painReported: false,
    });
    expect(res.actualDurationMin).toBe(30);
    expect(await workoutRow(id)).toMatchObject({ status: "done", actualDurationMin: 30 });
  });
});
