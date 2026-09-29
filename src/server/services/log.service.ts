import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  athleteProfiles,
  bodyCompositions,
  coachSessions,
  painLogs,
  workoutAnalyses,
  workouts,
} from "@/db/schema";
import type { IntensityBand, LoadVector, PainLocation } from "@/domain/core";
import type { IsoDate } from "@/domain/core/dates";
import { sessionRpeLoad } from "@/domain/load";
import { instantFor, localDate } from "@/server/time";

/**
 * "+" palette log targets (spec §84–88): coaching sessions (§24), rest days, body composition (§25)
 * and the active-pain list (§91–95). Quick activities go through `logQuickWorkout`
 * (workout.service) and pains through `logPain` / `resolvePain` (readiness.service).
 */

export const DEMO_LEVEL_VALUES = ["none", "light", "moderate", "heavy"] as const;
export type DemoLevel = (typeof DEMO_LEVEL_VALUES)[number];

export const COACH_SESSION_ALGORITHM_VERSION = "coach_session_v1" as const;

/**
 * Load attributed to a coaching session by physical demonstration level (spec §24: "pas
 * automatiquement un workout", but standing time and demos count in the recovery context).
 * Scale is the session LoadVector 0..10 (10 = maximal single-session load). Deliberately small:
 * a heavy demo day is roughly a third of an easy Zone 2 run in the cardiovascular dimension.
 * `standingMinutes ≥ STANDING_BONUS_MIN` adds `STANDING_BONUS` to `muscular_lower` (long days on
 * the floor tire the legs). A coaching session credits **no** stimulus: it never counts towards
 * the weekly exposure targets.
 */
export const COACH_SESSION_LOAD: Record<
  DemoLevel,
  { cardiovascular: number; muscular: number; impact: number; intensity: IntensityBand }
> = {
  none: { cardiovascular: 1, muscular: 1, impact: 0, intensity: "easy" },
  light: { cardiovascular: 1.5, muscular: 1.5, impact: 0.5, intensity: "easy" },
  moderate: { cardiovascular: 2, muscular: 2, impact: 0.5, intensity: "moderate" },
  heavy: { cardiovascular: 3, muscular: 3, impact: 1, intensity: "moderate" },
};
export const STANDING_BONUS_MIN = 120;
export const STANDING_BONUS = 0.5;

export function coachSessionLoadVector(demoLevel: DemoLevel, standingMinutes: number): LoadVector {
  const base = COACH_SESSION_LOAD[demoLevel];
  const standing = standingMinutes >= STANDING_BONUS_MIN ? STANDING_BONUS : 0;
  return {
    cardiovascular: base.cardiovascular,
    muscular_lower: Math.min(10, base.muscular + standing),
    muscular_upper: base.muscular,
    impact: base.impact,
    eccentric: 0,
    technical: 0,
  };
}

/** Perceived fatigue 1..5 → session RPE 1..10 (×2, capped), documented mapping. */
export function coachRpeFromFatigue(perceivedFatigue: number): number {
  return Math.max(1, Math.min(10, Math.round(perceivedFatigue * 2)));
}

export async function logCoachSession(
  db: Db,
  userId: string,
  input: {
    date: IsoDate;
    startMinute: number | null;
    durationMin: number;
    demoLevel: DemoLevel;
    standingMinutes: number;
    perceivedFatigue: number;
    timezone: string;
    notes?: string;
  },
): Promise<{ id: string }> {
  const rpe = coachRpeFromFatigue(input.perceivedFatigue);
  const intensity = COACH_SESSION_LOAD[input.demoLevel].intensity;
  const [w] = await db
    .insert(workouts)
    .values({
      userId,
      type: "coach_session",
      source: "manual",
      status: "done",
      date: input.date,
      startAt:
        input.startMinute != null
          ? instantFor(input.date, input.startMinute, input.timezone)
          : null,
      plannedDurationMin: input.durationMin,
      actualDurationMin: input.durationMin,
      title: "Coaching CrossFit",
      plannedIntensity: intensity,
      realisedIntensity: intensity,
      intensitySource: "CALCULATED",
      rpe,
      sessionRpeLoad: sessionRpeLoad(input.durationMin, rpe),
      fixed: true,
      notes: input.notes ?? "",
      finishedAt: new Date(),
    })
    .returning({ id: workouts.id });
  if (!w) throw new Error("workout insert failed");
  await db.insert(coachSessions).values({
    userId,
    workoutId: w.id,
    demoLevel: input.demoLevel,
    standingMinutes: input.standingMinutes,
    perceivedFatigue: input.perceivedFatigue,
  });
  await db.insert(workoutAnalyses).values({
    userId,
    workoutId: w.id,
    phase: "actual",
    date: input.date,
    stimulusCredits: {},
    loadVector: coachSessionLoadVector(input.demoLevel, input.standingMinutes),
    patternExposure: {},
    muscleExposure: {},
    energySystems: [],
    impactUnits: COACH_SESSION_LOAD[input.demoLevel].impact,
    intensity,
    heavyStrength: false,
    source: "CALCULATED",
    inputRef: `coach:${input.demoLevel}`,
    algorithmVersion: COACH_SESSION_ALGORITHM_VERSION,
    confidence: "MEDIUM",
  });
  return { id: w.id };
}

/** Rest day: one `rest` workout per date (idempotent), no analysis — rest is the absence of load. */
export async function logRestDay(
  db: Db,
  userId: string,
  input: { date: IsoDate },
): Promise<{ id: string; created: boolean }> {
  const [existing] = await db
    .select({ id: workouts.id })
    .from(workouts)
    .where(
      and(eq(workouts.userId, userId), eq(workouts.date, input.date), eq(workouts.type, "rest")),
    )
    .limit(1);
  if (existing) {
    await db
      .update(workouts)
      .set({ status: "done", finishedAt: new Date() })
      .where(and(eq(workouts.id, existing.id), eq(workouts.userId, userId)));
    return { id: existing.id, created: false };
  }
  const [w] = await db
    .insert(workouts)
    .values({
      userId,
      type: "rest",
      source: "manual",
      status: "done",
      date: input.date,
      plannedDurationMin: 0,
      actualDurationMin: 0,
      title: "Repos",
      plannedIntensity: "easy",
      realisedIntensity: "easy",
      intensitySource: "USER",
      finishedAt: new Date(),
    })
    .returning({ id: workouts.id });
  if (!w) throw new Error("workout insert failed");
  return { id: w.id, created: true };
}

export interface BodyCompositionView {
  id: string;
  measuredAt: string;
  localDate: IsoDate;
  weightKg: number;
  bodyFatPct: number | null;
  muscleMassKg: number | null;
  waterPct: number | null;
  source: string;
}

/**
 * Manual weigh-in (spec §25): one `body_compositions` row (`source = MANUAL`, `provider = manual`,
 * upserted on the same minute) and the profile's denormalised `bodyweightKg` set to the **latest**
 * measurement by `measured_at` (a back-dated entry never overrides a newer reading).
 */
export async function logBodyComposition(
  db: Db,
  userId: string,
  input: {
    measuredAt: Date;
    weightKg: number;
    bodyFatPct?: number | null;
    muscleMassKg?: number | null;
    waterPct?: number | null;
    timezone: string;
  },
): Promise<{ id: string }> {
  const values = {
    weightKg: input.weightKg,
    bodyFatPct: input.bodyFatPct ?? null,
    muscleMassKg: input.muscleMassKg ?? null,
    waterPct: input.waterPct ?? null,
  };
  const [row] = await db
    .insert(bodyCompositions)
    .values({
      userId,
      measuredAt: input.measuredAt,
      localDate: localDate(input.measuredAt, input.timezone),
      ...values,
      source: "MANUAL",
      provider: "manual",
    })
    .onConflictDoUpdate({
      target: [bodyCompositions.userId, bodyCompositions.measuredAt],
      targetWhere: sql`${bodyCompositions.source} = 'MANUAL'`,
      set: values,
    })
    .returning({ id: bodyCompositions.id });
  if (!row) throw new Error("body composition insert failed");

  const [latest] = await db
    .select({ weightKg: bodyCompositions.weightKg })
    .from(bodyCompositions)
    .where(eq(bodyCompositions.userId, userId))
    .orderBy(desc(bodyCompositions.measuredAt))
    .limit(1);
  const bodyweightKg = latest?.weightKg ?? input.weightKg;
  await db
    .insert(athleteProfiles)
    .values({ userId, bodyweightKg })
    .onConflictDoUpdate({ target: athleteProfiles.userId, set: { bodyweightKg } });
  return { id: row.id };
}

export async function listRecentBodyCompositions(
  db: Db,
  userId: string,
  limit = 8,
): Promise<BodyCompositionView[]> {
  const rows = await db
    .select()
    .from(bodyCompositions)
    .where(eq(bodyCompositions.userId, userId))
    .orderBy(desc(bodyCompositions.measuredAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    measuredAt: r.measuredAt.toISOString(),
    localDate: r.localDate,
    weightKg: r.weightKg,
    bodyFatPct: r.bodyFatPct,
    muscleMassKg: r.muscleMassKg,
    waterPct: r.waterPct,
    source: r.source,
  }));
}

export interface ActivePainView {
  id: string;
  location: PainLocation;
  side: string | null;
  intensity: number;
  movementSpecific: boolean;
  movements: string[];
  sudden: boolean;
  persistent: boolean;
  status: string;
  reportedAt: string;
  notes: string;
}

/** Pains the engine still reduces load for (`active` or `improving`). */
export async function listActivePains(db: Db, userId: string): Promise<ActivePainView[]> {
  const rows = await db
    .select()
    .from(painLogs)
    .where(and(eq(painLogs.userId, userId), inArray(painLogs.status, ["active", "improving"])))
    .orderBy(desc(painLogs.reportedAt));
  return rows.map((p) => ({
    id: p.id,
    location: p.location,
    side: p.side,
    intensity: p.intensity,
    movementSpecific: p.movementSpecific,
    movements: p.movements,
    sudden: p.sudden,
    persistent: p.persistent,
    status: p.status,
    reportedAt: p.reportedAt.toISOString(),
    notes: p.notes,
  }));
}
