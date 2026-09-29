import "server-only";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { crossfitWorkouts, workoutAnalyses, workoutExercises, workouts } from "@/db/schema";
import {
  FEELING_TO_FUN,
  toConfidence,
  type Feeling,
  type IntensityBand,
  type WorkoutType,
} from "@/domain/core";
import type { IsoDate } from "@/domain/core/dates";
import { getCatalogEntry, type LoadProfile, type Option } from "@/domain/engine";
import { sessionRpeLoad } from "@/domain/load";
import { scaleTemplateLoadToActual, ACTUAL_SCALING_VERSION } from "@/domain/load";
import { analyzeWod, type NormalizedWod, type WodAnalysis } from "@/domain/wod";
import { getExercise } from "@/domain/exercises";
import { STRENGTH_TEMPLATES } from "@/domain/strength";
import { NotFoundError } from "@/server/errors";
import { instantFor } from "@/server/time";

export interface CreatedWorkout {
  id: string;
  type: WorkoutType;
}

function typeOfOption(o: Option): WorkoutType {
  if (o.family === "crossfit" || o.family === "partner" || o.family === "benchmark")
    return "crossfit";
  if (
    o.family.startsWith("strength") ||
    o.family === "accessory" ||
    o.family === "olympic" ||
    o.family === "gymnastics"
  )
    return "strength";
  if (o.family === "rest") return "rest";
  if (o.family === "mobility") return "mobility";
  if (o.family === "hyrox" || o.family === "just_move") return "free";
  return "cardio";
}

export function analysisRowFromProfile(
  p: LoadProfile,
  source: "CALCULATED" | "AI_PARSED" | "ENGINE",
  algorithmVersion: string,
  confidence: number,
  inputRef: string | null,
) {
  return {
    stimulusCredits: p.expectedCredits,
    loadVector: p.loadVector,
    patternExposure: p.patterns,
    muscleExposure: {},
    energySystems: [],
    impactUnits: p.impactUnits,
    intensity: p.intensity,
    heavyStrength: p.heavyStrength,
    source,
    inputRef,
    algorithmVersion,
    confidence: toConfidence(confidence),
  };
}

/** Create a planned workout from an accepted engine option (START on Today). */
export async function createWorkoutFromOption(
  db: Db,
  userId: string,
  opts: {
    option: Option;
    date: IsoDate;
    timezone: string;
    recommendationId: string | null;
    startMinute?: number | null;
    expectedRpe?: number | null;
  },
): Promise<CreatedWorkout> {
  const { option: o } = opts;
  const type = typeOfOption(o);
  const [w] = await db
    .insert(workouts)
    .values({
      userId,
      type,
      source: "planned_engine",
      status: type === "rest" ? "done" : "planned",
      date: opts.date,
      startAt:
        opts.startMinute != null ? instantFor(opts.date, opts.startMinute, opts.timezone) : null,
      plannedDurationMin: o.durationMin,
      title: o.title,
      plannedIntensity: o.intensity,
      intensitySource: "ENGINE",
      recommendationId: opts.recommendationId,
      fixed: false,
      expectedRpe:
        opts.expectedRpe ?? (o.intensity === "hard" ? 8 : o.intensity === "moderate" ? 6.5 : 4),
    })
    .returning({ id: workouts.id });
  if (!w) throw new Error("workout insert failed");
  await db
    .insert(workoutAnalyses)
    .values({
      userId,
      workoutId: w.id,
      phase: "planned",
      date: opts.date,
      ...analysisRowFromProfile(o, "ENGINE", "candidate_catalog_v1", 1, o.kind),
    })
    .onConflictDoNothing();

  if (type === "strength") {
    const template =
      (o.templateId ? STRENGTH_TEMPLATES.find((t) => t.id === o.templateId) : undefined) ??
      STRENGTH_TEMPLATES.find((t) => t.kind === o.kind);
    if (template) {
      await db.insert(workoutExercises).values(
        template.exercises.map((ex, i) => ({
          userId,
          workoutId: w.id,
          date: opts.date,
          order: i,
          exerciseId: ex.exerciseId,
          prescription: ex.prescription,
          source: "ENGINE",
        })),
      );
    }
  }
  return { id: w.id, type };
}

/** Create a FIXED CrossFit class workout from a confirmed inbox item (spec §49). */
export async function createCrossfitWorkoutFromWod(
  db: Db,
  userId: string,
  opts: {
    date: IsoDate;
    startMinute: number | null;
    timezone: string;
    wod: NormalizedWod;
    analysis: WodAnalysis;
    inboxItemId: string;
    title?: string;
  },
): Promise<CreatedWorkout> {
  const a = opts.analysis;
  const [w] = await db
    .insert(workouts)
    .values({
      userId,
      type: "crossfit",
      source: "wod_inbox",
      status: "planned",
      date: opts.date,
      startAt:
        opts.startMinute != null ? instantFor(opts.date, opts.startMinute, opts.timezone) : null,
      plannedDurationMin: a.estimatedDurationMin,
      title: opts.title ?? (opts.wod.title ? `CrossFit — ${opts.wod.title}` : "CrossFit"),
      plannedIntensity: a.intensity,
      intensitySource: "CALCULATED",
      fixed: true,
      expectedRpe: a.intensity === "hard" ? 8 : a.intensity === "moderate" ? 6.5 : 4,
    })
    .returning({ id: workouts.id });
  if (!w) throw new Error("workout insert failed");
  await db.insert(crossfitWorkouts).values({
    userId,
    workoutId: w.id,
    wodInboxItemId: opts.inboxItemId,
    normalizedWod: opts.wod,
    timeDomain: a.timeDomain,
  });
  await db.insert(workoutAnalyses).values({
    userId,
    workoutId: w.id,
    phase: "planned",
    date: opts.date,
    stimulusCredits: a.stimulusCredits,
    loadVector: a.loadVector,
    patternExposure: a.patternExposure,
    muscleExposure: a.muscleExposure,
    energySystems: a.energySystems,
    impactUnits: a.impactUnits,
    intensity: a.intensity,
    heavyStrength: a.dominant === "strength" || a.dominant === "mixed",
    source: "CALCULATED",
    inputRef: opts.inboxItemId,
    algorithmVersion: a.algorithmVersion,
    confidence: toConfidence(a.confidence),
  });
  // Materialise one workout_exercises row per resolved exercise (DATA_MODEL §3).
  const seen = new Set<string>();
  const rows: Array<typeof workoutExercises.$inferInsert> = [];
  let order = 0;
  opts.wod.parts.forEach((part, blockIndex) => {
    for (const m of part.movements) {
      if (!m.exerciseId || seen.has(m.exerciseId) || !getExercise(m.exerciseId)) continue;
      seen.add(m.exerciseId);
      rows.push({
        userId,
        workoutId: w.id,
        date: opts.date,
        order: order++,
        blockIndex,
        exerciseId: m.exerciseId,
        prescription: {
          ...m,
          reps: m.reps ?? (part.repScheme ? part.repScheme.reduce((x, y) => x + y, 0) : part.reps),
          sets: m.sets ?? part.sets,
        },
        source: opts.wod.parser === "USER" ? "USER" : "AI_PARSED",
        confidence: m.resolutionConfidence,
      });
    }
  });
  if (rows.length) await db.insert(workoutExercises).values(rows);
  return { id: w.id, type: "crossfit" };
}

/** Post-session feedback (spec §22) → actual analysis (planned × RPE/duration scaling) + session-RPE load. */
export async function completeWorkout(
  db: Db,
  userId: string,
  opts: {
    workoutId: string;
    rpe: number | null;
    feeling: Feeling | null;
    painReported: boolean;
    actualDurationMin?: number | null;
    notes?: string;
    finishedAt?: Date;
    realisedIntensity?: IntensityBand | null;
    score?: {
      kind: "time" | "rounds_reps" | "reps" | "load";
      value: number;
      extraReps?: number | null;
      rx: boolean;
      scaledNotes?: string;
    } | null;
  },
): Promise<void> {
  const [w] = await db
    .select()
    .from(workouts)
    .where(and(eq(workouts.id, opts.workoutId), eq(workouts.userId, userId)))
    .limit(1);
  if (!w) throw new NotFoundError("Séance");
  const durationMin = opts.actualDurationMin ?? w.actualDurationMin ?? w.plannedDurationMin ?? 45;
  const load = sessionRpeLoad(durationMin, opts.rpe);
  await db
    .update(workouts)
    .set({
      status: "done",
      rpe: opts.rpe,
      feeling: opts.feeling,
      painReported: opts.painReported,
      actualDurationMin: durationMin,
      finishedAt: opts.finishedAt ?? new Date(),
      notes: opts.notes ?? w.notes,
      sessionRpeLoad: load,
      realisedIntensity: opts.realisedIntensity ?? w.plannedIntensity,
    })
    .where(eq(workouts.id, w.id));
  if (opts.score)
    await db
      .update(crossfitWorkouts)
      .set({
        score: {
          kind: opts.score.kind,
          value: opts.score.value,
          extraReps: opts.score.kind === "rounds_reps" ? (opts.score.extraReps ?? null) : null,
          rx: opts.score.rx,
          scaledNotes: opts.score.scaledNotes ?? "",
        },
      })
      .where(and(eq(crossfitWorkouts.workoutId, w.id), eq(crossfitWorkouts.userId, userId)));

  const [planned] = await db
    .select()
    .from(workoutAnalyses)
    .where(and(eq(workoutAnalyses.workoutId, w.id), eq(workoutAnalyses.phase, "planned")))
    .limit(1);
  if (planned) {
    const scaled = scaleTemplateLoadToActual(planned.loadVector, {
      rpe: opts.rpe,
      expectedRpe: w.expectedRpe,
      actualMin: durationMin,
      plannedMin: w.plannedDurationMin,
    });
    await db
      .insert(workoutAnalyses)
      .values({
        userId,
        workoutId: w.id,
        phase: "actual",
        date: w.date,
        stimulusCredits: planned.stimulusCredits,
        loadVector: scaled.loadVector,
        patternExposure: planned.patternExposure,
        muscleExposure: planned.muscleExposure,
        energySystems: planned.energySystems,
        impactUnits: planned.impactUnits,
        intensity: opts.realisedIntensity ?? planned.intensity,
        heavyStrength: planned.heavyStrength,
        source: "CALCULATED",
        inputRef: planned.inputRef,
        algorithmVersion: `${planned.algorithmVersion}+${ACTUAL_SCALING_VERSION}`,
        confidence:
          scaled.estimated && planned.confidence === "HIGH" ? "MEDIUM" : planned.confidence,
      })
      .onConflictDoUpdate({
        target: [workoutAnalyses.workoutId, workoutAnalyses.phase],
        set: {
          loadVector: scaled.loadVector,
          intensity: opts.realisedIntensity ?? planned.intensity,
          computedAt: new Date(),
        },
      });
  }
}

export async function skipWorkout(db: Db, userId: string, workoutId: string): Promise<void> {
  await db
    .update(workouts)
    .set({ status: "skipped" })
    .where(and(eq(workouts.id, workoutId), eq(workouts.userId, userId)));
}

export async function moveWorkout(
  db: Db,
  userId: string,
  workoutId: string,
  toDate: IsoDate,
  timezone: string,
): Promise<void> {
  const [w] = await db
    .select()
    .from(workouts)
    .where(and(eq(workouts.id, workoutId), eq(workouts.userId, userId)))
    .limit(1);
  if (!w) throw new NotFoundError("Séance");
  const minute = w.startAt
    ? Math.round(((w.startAt.getTime() - instantFor(w.date, 0, timezone).getTime()) / 60000) % 1440)
    : null;
  await db
    .update(workouts)
    .set({
      date: toDate,
      startAt: minute != null ? instantFor(toDate, minute, timezone) : null,
      status: w.status === "planned" ? "auto_adjusted" : w.status,
    })
    .where(eq(workouts.id, w.id));
  await db.update(workoutAnalyses).set({ date: toDate }).where(eq(workoutAnalyses.workoutId, w.id));
  await db
    .update(workoutExercises)
    .set({ date: toDate })
    .where(eq(workoutExercises.workoutId, w.id));
}

/** Log a done session quickly ("+ Log activity / Rest / Coach"). */
export async function logQuickWorkout(
  db: Db,
  userId: string,
  opts: {
    date: IsoDate;
    type: WorkoutType;
    title: string;
    durationMin: number;
    rpe: number | null;
    feeling: Feeling | null;
    intensity: IntensityBand;
    kind?: string | null;
    timezone: string;
  },
): Promise<CreatedWorkout> {
  const catalog = opts.kind ? getCatalogEntry(opts.kind) : undefined;
  const [w] = await db
    .insert(workouts)
    .values({
      userId,
      type: opts.type,
      source: "manual",
      status: "done",
      date: opts.date,
      plannedDurationMin: opts.durationMin,
      actualDurationMin: opts.durationMin,
      title: opts.title,
      plannedIntensity: opts.intensity,
      realisedIntensity: opts.intensity,
      intensitySource: "USER",
      rpe: opts.rpe,
      feeling: opts.feeling,
      sessionRpeLoad: sessionRpeLoad(opts.durationMin, opts.rpe),
      finishedAt: new Date(),
    })
    .returning({ id: workouts.id });
  if (!w) throw new Error("workout insert failed");
  if (catalog) {
    const profile: LoadProfile = {
      expectedCredits: catalog.expectedCredits,
      loadVector: catalog.loadVector,
      intensity: catalog.intensity,
      heavyStrength: catalog.heavyStrength ?? false,
      durationMin: opts.durationMin,
      modality: catalog.modality,
      patterns: catalog.patterns,
      impactUnits: catalog.impactUnits ?? 0,
    };
    const scaled = scaleTemplateLoadToActual(profile.loadVector, {
      rpe: opts.rpe,
      expectedRpe: catalog.intensity === "hard" ? 8 : catalog.intensity === "moderate" ? 6.5 : 4,
      actualMin: opts.durationMin,
      plannedMin: catalog.durationMin,
    });
    await db.insert(workoutAnalyses).values({
      userId,
      workoutId: w.id,
      phase: "actual",
      date: opts.date,
      ...analysisRowFromProfile(
        { ...profile, loadVector: scaled.loadVector },
        "CALCULATED",
        `candidate_catalog_v1+${ACTUAL_SCALING_VERSION}`,
        opts.rpe ? 0.8 : 0.5,
        opts.kind ?? null,
      ),
    });
  }
  return { id: w.id, type: opts.type };
}

export function funScoreOf(feeling: Feeling | null): number | null {
  return feeling ? FEELING_TO_FUN[feeling] : null;
}

export { analyzeWod };
