import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  activities,
  benchmarks,
  cardioWorkouts,
  coachSessions,
  crossfitWorkouts,
  exercises,
  personalRecords,
  recommendations,
  strengthSets,
  workoutAnalyses,
  workoutExercises,
  workouts,
  type CrossfitScore,
} from "@/db/schema";
import { estimateDurationMin, flattenSteps, type CardioStep } from "@/domain/cardio";
import {
  LOAD_DIMENSION_VALUES,
  type CardioKind,
  type Confidence,
  type Feeling,
  type IntensityBand,
  type LoadDimension,
  type Modality,
  type StimulusKey,
  type WorkoutSource,
  type WorkoutStatus,
  type WorkoutType,
} from "@/domain/core";
import { DIMENSION_LABEL_FR, STIMULUS_LABEL_FR } from "@/domain/engine";
import { getExercise } from "@/domain/exercises";
import { StrengthPrescriptionSchema, type StrengthPrescription } from "@/domain/strength";
import type { NormalizedWod } from "@/domain/wod";
import type { TimeDomain } from "@/domain/wod";
import { localMinute } from "@/server/time";
import { funScoreOf } from "./workout.service";
import type { StrengthSetView } from "./view-models";

/**
 * Workout detail page view (ARCHITECTURE §3 `/workouts/[id]`). Plain data only: components import
 * these types with `import type`. Every number that comes from an analysis is an estimate and is
 * flagged as such so the page renders "≈" (ARCHITECTURE §5).
 */

export interface StrengthExerciseDetail {
  id: string;
  exerciseId: string;
  name: string;
  order: number;
  /** Null when the row carries a WOD movement instead of a strength prescription. */
  prescription: StrengthPrescription | null;
  sets: StrengthSetView[];
  /** Best working-set e1RM of this workout (estimated, Epley). */
  bestSetE1rmKg: number | null;
  /** Id of the set that produced `bestSetE1rmKg`. */
  bestSetId: string | null;
  /** True when a `personal_records` e1RM row points at this workout for this exercise. */
  isPr: boolean;
  /** Previous best e1RM before this PR (from the PR row), when known. */
  previousBestKg: number | null;
}

export interface StrengthDetail {
  exercises: StrengthExerciseDetail[];
  workingSets: number;
  /** Σ reps × kg over working sets (declared values, not estimated). */
  volumeKg: number;
}

export interface CrossfitDetail {
  wod: NormalizedWod | null;
  score: CrossfitScore | null;
  benchmarkId: string | null;
  benchmarkName: string | null;
  timeDomain: TimeDomain | null;
}

export interface CardioStepView {
  kind: string;
  durationSec: number | null;
  distanceM: number | null;
  target: string | null;
}

export interface CardioDetail {
  modality: Modality;
  kind: CardioKind;
  stepCount: number;
  /** Estimated total from the steps (distance steps via pace defaults); null when unknown. */
  estimatedDurationMin: number | null;
  steps: CardioStepView[];
  garminSyncStatus: string;
  lastSyncError: string | null;
}

export interface CoachDetail {
  demoLevel: string;
  standingMinutes: number;
  perceivedFatigue: number | null;
}

export interface AnalysisView {
  phase: "planned" | "actual";
  load: Array<{ key: LoadDimension; label: string; value: number }>;
  credits: Array<{ key: StimulusKey; label: string; value: number }>;
  intensity: IntensityBand;
  confidence: Confidence;
  source: string;
  algorithmVersion: string;
  impactUnits: number;
  /** Analyses are always model outputs, never measurements. */
  estimated: true;
}

export interface LinkedActivityView {
  id: string;
  sport: string;
  provider: string;
  startAt: string;
  durationSec: number;
  distanceM: number | null;
  avgHr: number | null;
}

export interface WhyView {
  explanation: string;
  rulesTriggered: string[];
  confidence: Confidence;
  date: string;
}

export interface WorkoutDetailView {
  id: string;
  date: string;
  type: WorkoutType;
  status: WorkoutStatus;
  source: WorkoutSource;
  title: string;
  startMinute: number | null;
  plannedDurationMin: number | null;
  actualDurationMin: number | null;
  plannedIntensity: IntensityBand | null;
  realisedIntensity: IntensityBand | null;
  intensitySource: string;
  fixed: boolean;
  rpe: number | null;
  expectedRpe: number | null;
  feeling: Feeling | null;
  funScore: number | null;
  painReported: boolean;
  notes: string;
  sessionRpeLoad: number | null;
  finishedAt: string | null;
  strength: StrengthDetail | null;
  crossfit: CrossfitDetail | null;
  cardio: CardioDetail | null;
  coach: CoachDetail | null;
  analysis: { planned: AnalysisView | null; actual: AnalysisView | null };
  activities: LinkedActivityView[];
  why: WhyView | null;
}

function toAnalysisView(row: typeof workoutAnalyses.$inferSelect): AnalysisView {
  const credits = (Object.entries(row.stimulusCredits) as Array<[StimulusKey, number]>)
    .filter(([, v]) => v > 0)
    .map(([key, value]) => ({ key, label: STIMULUS_LABEL_FR[key] ?? key, value }));
  return {
    phase: row.phase,
    load: LOAD_DIMENSION_VALUES.map((key) => ({
      key,
      label: DIMENSION_LABEL_FR[key],
      value: row.loadVector[key] ?? 0,
    })),
    credits,
    intensity: row.intensity,
    confidence: row.confidence,
    source: row.source,
    algorithmVersion: row.algorithmVersion,
    impactUnits: row.impactUnits,
    estimated: true,
  };
}

function describeTarget(step: CardioStep): string | null {
  const t = step.target;
  if (!t) return null;
  switch (t.type) {
    case "hr_zone":
      return t.zone != null ? `Z${t.zone}` : "zone FC";
    case "pace_sec_km":
      return t.min != null || t.max != null ? "allure cible" : null;
    case "open":
      return null;
    default:
      return t.type.replace(/_/g, " ");
  }
}

async function strengthDetail(db: Db, userId: string, workoutId: string): Promise<StrengthDetail> {
  const exRows = await db
    .select()
    .from(workoutExercises)
    .where(and(eq(workoutExercises.workoutId, workoutId), eq(workoutExercises.userId, userId)))
    .orderBy(asc(workoutExercises.order));
  const setRows = await db
    .select()
    .from(strengthSets)
    .where(and(eq(strengthSets.workoutId, workoutId), eq(strengthSets.userId, userId)))
    .orderBy(asc(strengthSets.completedAt), asc(strengthSets.setIndex));
  const prRows = await db
    .select({
      exerciseId: personalRecords.exerciseId,
      value: personalRecords.value,
      previousValue: personalRecords.previousValue,
    })
    .from(personalRecords)
    .where(
      and(
        eq(personalRecords.userId, userId),
        eq(personalRecords.kind, "e1rm"),
        eq(personalRecords.workoutId, workoutId),
        eq(personalRecords.superseded, false),
      ),
    );
  const prByExercise = new Map<string, { value: number; previousValue: number | null }>();
  for (const pr of prRows)
    if (pr.exerciseId)
      prByExercise.set(pr.exerciseId, { value: pr.value, previousValue: pr.previousValue });

  const ids = [...new Set(exRows.map((e) => e.exerciseId))];
  const names = new Map<string, string>();
  if (ids.length) {
    const rows = await db
      .select({ id: exercises.id, name: exercises.name })
      .from(exercises)
      .where(inArray(exercises.id, ids));
    for (const r of rows) names.set(r.id, r.name);
  }

  const setsByExercise = new Map<string, StrengthSetView[]>();
  for (const s of setRows) {
    const view: StrengthSetView = {
      id: s.id,
      setIndex: s.setIndex,
      reps: s.reps,
      weightKg: s.weightKg,
      rpe: s.rpe,
      quality: s.quality,
      isWarmup: s.isWarmup,
      completedAt: s.completedAt.toISOString(),
      e1rmKg: s.e1rmKg,
    };
    setsByExercise.set(s.workoutExerciseId, [
      ...(setsByExercise.get(s.workoutExerciseId) ?? []),
      view,
    ]);
  }

  let workingSets = 0;
  let volumeKg = 0;
  const list: StrengthExerciseDetail[] = exRows.map((e) => {
    const sets = setsByExercise.get(e.id) ?? [];
    let best: StrengthSetView | null = null;
    for (const s of sets) {
      if (s.isWarmup) continue;
      workingSets += 1;
      if (s.reps != null && s.weightKg != null) volumeKg += s.reps * s.weightKg;
      if (s.e1rmKg != null && (best === null || (best.e1rmKg ?? 0) < s.e1rmKg)) best = s;
    }
    const pr = prByExercise.get(e.exerciseId);
    const bestE1rm = best?.e1rmKg ?? null;
    const isPr = pr != null && bestE1rm != null && bestE1rm >= pr.value - 0.01;
    const parsed = StrengthPrescriptionSchema.safeParse(e.prescription);
    return {
      id: e.id,
      exerciseId: e.exerciseId,
      name: names.get(e.exerciseId) ?? getExercise(e.exerciseId)?.name ?? e.exerciseId,
      order: e.order,
      prescription: parsed.success ? parsed.data : null,
      sets,
      bestSetE1rmKg: bestE1rm,
      bestSetId: best?.id ?? null,
      isPr,
      previousBestKg: isPr ? (pr?.previousValue ?? null) : null,
    };
  });
  return { exercises: list, workingSets, volumeKg: Math.round(volumeKg) };
}

async function crossfitDetail(
  db: Db,
  userId: string,
  workoutId: string,
): Promise<CrossfitDetail | null> {
  const [cf] = await db
    .select()
    .from(crossfitWorkouts)
    .where(and(eq(crossfitWorkouts.workoutId, workoutId), eq(crossfitWorkouts.userId, userId)))
    .limit(1);
  if (!cf) return null;
  let benchmarkName: string | null = null;
  if (cf.benchmarkId) {
    const [b] = await db
      .select({ name: benchmarks.name })
      .from(benchmarks)
      .where(eq(benchmarks.id, cf.benchmarkId))
      .limit(1);
    benchmarkName = b?.name ?? null;
  }
  return {
    wod: cf.normalizedWod,
    score: cf.score,
    benchmarkId: cf.benchmarkId,
    benchmarkName,
    timeDomain: cf.timeDomain,
  };
}

async function cardioDetail(
  db: Db,
  userId: string,
  workoutId: string,
  title: string,
): Promise<CardioDetail | null> {
  const [c] = await db
    .select()
    .from(cardioWorkouts)
    .where(and(eq(cardioWorkouts.workoutId, workoutId), eq(cardioWorkouts.userId, userId)))
    .limit(1);
  if (!c) return null;
  const flat = flattenSteps(c.steps);
  const estimate = c.steps.length
    ? estimateDurationMin({ modality: c.modality, kind: c.workoutKind, title, steps: c.steps })
    : 0;
  return {
    modality: c.modality,
    kind: c.workoutKind,
    stepCount: flat.length,
    estimatedDurationMin: estimate > 0 ? estimate : null,
    steps: flat.map((s) => ({
      kind: s.kind,
      durationSec: s.durationSec ?? null,
      distanceM: s.distanceM ?? null,
      target: describeTarget(s),
    })),
    garminSyncStatus: c.garminSyncStatus,
    lastSyncError: c.lastSyncError,
  };
}

async function coachDetail(db: Db, userId: string, workoutId: string): Promise<CoachDetail | null> {
  const [s] = await db
    .select()
    .from(coachSessions)
    .where(and(eq(coachSessions.workoutId, workoutId), eq(coachSessions.userId, userId)))
    .limit(1);
  if (!s) return null;
  return {
    demoLevel: s.demoLevel,
    standingMinutes: s.standingMinutes,
    perceivedFatigue: s.perceivedFatigue,
  };
}

/** One bundle for `/workouts/[id]`; null when the workout does not belong to the user. */
export async function getWorkoutDetail(
  db: Db,
  userId: string,
  workoutId: string,
  timezone = "Europe/Paris",
): Promise<WorkoutDetailView | null> {
  const [w] = await db
    .select()
    .from(workouts)
    .where(and(eq(workouts.id, workoutId), eq(workouts.userId, userId)))
    .limit(1);
  if (!w) return null;

  const [analysisRows, activityRows] = await Promise.all([
    db
      .select()
      .from(workoutAnalyses)
      .where(and(eq(workoutAnalyses.workoutId, w.id), eq(workoutAnalyses.userId, userId))),
    db
      .select({
        id: activities.id,
        sport: activities.sport,
        provider: activities.provider,
        startAt: activities.startAt,
        durationSec: activities.durationSec,
        distanceM: activities.distanceM,
        avgHr: activities.avgHr,
      })
      .from(activities)
      .where(and(eq(activities.workoutId, w.id), eq(activities.userId, userId)))
      .orderBy(asc(activities.startAt)),
  ]);

  let why: WhyView | null = null;
  if (w.recommendationId) {
    const [rec] = await db
      .select({
        explanation: recommendations.explanation,
        rulesTriggered: recommendations.rulesTriggered,
        confidence: recommendations.confidence,
        date: recommendations.date,
      })
      .from(recommendations)
      .where(and(eq(recommendations.id, w.recommendationId), eq(recommendations.userId, userId)))
      .limit(1);
    if (rec)
      why = {
        explanation: rec.explanation,
        rulesTriggered: rec.rulesTriggered,
        confidence: rec.confidence,
        date: rec.date,
      };
  }

  const planned = analysisRows.find((a) => a.phase === "planned");
  const actual = analysisRows.find((a) => a.phase === "actual");

  return {
    id: w.id,
    date: w.date,
    type: w.type,
    status: w.status,
    source: w.source,
    title: w.title,
    startMinute: w.startAt ? localMinute(w.startAt, timezone) : null,
    plannedDurationMin: w.plannedDurationMin,
    actualDurationMin: w.actualDurationMin,
    plannedIntensity: w.plannedIntensity,
    realisedIntensity: w.realisedIntensity,
    intensitySource: w.intensitySource,
    fixed: w.fixed,
    rpe: w.rpe,
    expectedRpe: w.expectedRpe,
    feeling: w.feeling,
    funScore: funScoreOf(w.feeling),
    painReported: w.painReported,
    notes: w.notes,
    sessionRpeLoad: w.sessionRpeLoad,
    finishedAt: w.finishedAt ? w.finishedAt.toISOString() : null,
    strength: w.type === "strength" ? await strengthDetail(db, userId, w.id) : null,
    crossfit: w.type === "crossfit" ? await crossfitDetail(db, userId, w.id) : null,
    cardio: w.type === "cardio" ? await cardioDetail(db, userId, w.id, w.title) : null,
    coach: w.type === "coach_session" ? await coachDetail(db, userId, w.id) : null,
    analysis: {
      planned: planned ? toAnalysisView(planned) : null,
      actual: actual ? toAnalysisView(actual) : null,
    },
    activities: activityRows.map((a) => ({
      id: a.id,
      sport: a.sport,
      provider: a.provider,
      startAt: a.startAt.toISOString(),
      durationSec: a.durationSec,
      distanceM: a.distanceM,
      avgHr: a.avgHr,
    })),
    why,
  };
}
