import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
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
import {
  catalogToCandidate,
  getCatalogEntry,
  type LoadProfile,
  type Option,
} from "@/domain/engine";
import { classifyIntensity, sessionRpeLoad } from "@/domain/load";
import { scaleTemplateLoadToActual, ACTUAL_SCALING_VERSION } from "@/domain/load";
import {
  analyzeWod,
  type NormalizedWod,
  type WodAnalysis,
  type WodMovement,
  type WodPart,
} from "@/domain/wod";
import { getExercise } from "@/domain/exercises";
import { STRENGTH_TEMPLATES } from "@/domain/strength";
import { NotFoundError } from "@/server/errors";
import { instantFor, localDate, localMinute } from "@/server/time";
import { ENGINE_PLANNED_STATUSES, kindOf } from "./engine-input";

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

/** Server-side Option for a catalog kind (never the client's numbers); null when the kind is unknown. */
export function optionFromCatalog(kind: string): Option | null {
  const entry = getCatalogEntry(kind);
  if (!entry) return null;
  const c = catalogToCandidate(entry, "catalog");
  return {
    kind: c.kind,
    family: c.family,
    title: c.title,
    origin: c.origin,
    templateId: c.templateId,
    isTest: c.isTest,
    testKey: c.testKey,
    expectedCredits: c.expectedCredits,
    loadVector: c.loadVector,
    intensity: c.intensity,
    heavyStrength: c.heavyStrength,
    durationMin: c.durationMin,
    modality: c.modality,
    patterns: c.patterns,
    impactUnits: c.impactUnits,
    score: 0,
    reason: "Option du catalogue",
  };
}

export interface OpenWorkoutRef {
  id: string;
  type: WorkoutType;
  fixed: boolean;
}

/**
 * The open session (planned / in progress / replanned) an engine option refers to on `date`: by
 * `plannedId` when the option carries one, else the first non-fixed session of the same catalog
 * kind. START reuses it instead of inserting a duplicate row.
 */
export async function findOpenWorkoutForOption(
  db: Db,
  userId: string,
  opts: { date: IsoDate; kind: string; plannedId?: string | null },
): Promise<OpenWorkoutRef | null> {
  const rows = await db
    .select({
      id: workouts.id,
      type: workouts.type,
      fixed: workouts.fixed,
      title: workouts.title,
      date: workouts.date,
    })
    .from(workouts)
    .where(
      and(
        eq(workouts.userId, userId),
        eq(workouts.date, opts.date),
        inArray(workouts.status, [...ENGINE_PLANNED_STATUSES]),
      ),
    )
    .orderBy(asc(workouts.startAt), asc(workouts.createdAt));
  const byId = opts.plannedId ? rows.find((w) => w.id === opts.plannedId) : undefined;
  const match = byId ?? rows.find((w) => !w.fixed && kindOf(w) === opts.kind);
  return match ? { id: match.id, type: match.type, fixed: match.fixed } : null;
}

/** Route that opens a workout in the right mode. */
export function routeForWorkout(w: { id: string; type: WorkoutType; fixed?: boolean }): string {
  if (!w.fixed && w.type === "strength") return `/train/strength/${w.id}`;
  if (!w.fixed && w.type === "cardio") return `/train/cardio/${w.id}`;
  return `/workouts/${w.id}`;
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
    /** Known e1RMs by exercise id (kg): absolute loads become a share of 1RM for the heavy check. */
    e1rms?: Readonly<Record<string, number>>;
  },
): Promise<CreatedWorkout> {
  const a = opts.analysis;
  const heavyStrength = wodHeavyStrength(opts.wod, a, opts.e1rms);
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
    heavyStrength,
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

const COMPOUND_CATEGORIES: ReadonlySet<string> = new Set(["barbell", "olympic"]);
const HEAVY_PERCENT_1RM = 80;
const HEAVY_E1RM_RATIO = 0.8;
const HEAVY_MAX_REPS = 5;

/**
 * Heavy strength for a class WOD (ENGINE.md: "any compound set at RPE ≥ 8", budget ≤ 3 / 7 days).
 * `dominant = strength | mixed` only says a strength part exists, whatever its load, so a light
 * technique piece before the metcon must not burn the heavy budget. Uses `analysis.heavyStrength`
 * when the analyzer exposes it; otherwise a strength-part compound lift (barbell / olympic) counts
 * when prescribed `heavy` / `build`, ≥ 80 %1RM, ≥ 0.8 × a known e1RM, or — with no usable load
 * reference — at ≤ 5 reps per set. Everything else (light, %, hypertrophy volume) is not heavy.
 */
export function wodHeavyStrength(
  wod: NormalizedWod,
  analysis: WodAnalysis,
  e1rms: Readonly<Record<string, number>> = {},
): boolean {
  const declared = (analysis as { heavyStrength?: unknown }).heavyStrength;
  if (typeof declared === "boolean") return declared;
  return wod.parts.some(
    (part) =>
      part.kind === "strength" && part.movements.some((m) => isHeavyStrengthSet(part, m, e1rms)),
  );
}

function isHeavyStrengthSet(
  part: WodPart,
  m: WodMovement,
  e1rms: Readonly<Record<string, number>>,
): boolean {
  const def = m.exerciseId ? getExercise(m.exerciseId) : undefined;
  if (!def || !COMPOUND_CATEGORIES.has(def.category)) return false;
  const load = m.load;
  if (load?.qualifier) return load.qualifier === "heavy" || load.qualifier === "build";
  if (load?.unit === "percent_1rm") return load.value >= HEAVY_PERCENT_1RM;
  const kg = load
    ? load.unit === "kg"
      ? load.value
      : load.unit === "lb"
        ? load.value * 0.4536
        : null
    : null;
  const e1rm = e1rms[def.id];
  if (kg != null && kg > 0 && e1rm && e1rm > 0) return kg / e1rm >= HEAVY_E1RM_RATIO;
  const reps = m.reps ?? part.reps ?? m.repScheme?.[0] ?? part.repScheme?.[0] ?? null;
  return reps != null && reps > 0 && reps <= HEAVY_MAX_REPS;
}

const BAND_RANK: Record<IntensityBand, number> = { easy: 0, moderate: 1, hard: 2 };

/**
 * Realised band after feedback: the deterministic classifier (metabolic axis, ENGINE.md) over the
 * RPE-scaled load, RPE and heavy-strength flag — upgrade only, since the stored analysis no longer
 * carries the parse-time signals (metcon time domain, benchmark, cardio kind) that made it hard.
 */
export function realisedBandFromFeedback(
  base: IntensityBand | null,
  input: {
    loadVector: LoadProfile["loadVector"] | null;
    rpe: number | null;
    heavyStrength: boolean;
  },
): IntensityBand | null {
  if (input.rpe == null) return base;
  const band = classifyIntensity({
    loadVector: input.loadVector,
    rpe: input.rpe,
    heavyStrength: input.heavyStrength,
  }).band;
  if (!base) return band;
  return BAND_RANK[band] > BAND_RANK[base] ? band : base;
}

/**
 * Post-session feedback (spec §22) → actual analysis (planned × RPE/duration scaling) + session-RPE
 * load. Rules:
 *  - the actual duration is persisted only when someone measured or declared it (the planned
 *    duration serves the load computation but is never stored as "réelle");
 *  - `finished_at` is the feedback time on the day of the session; late feedback (a later local
 *    day) is stamped at the planned end (start + duration), never "now";
 *  - the realised intensity is upgraded from the RPE (`realisedBandFromFeedback`) unless given;
 *  - "Modifier le ressenti" on a workout finished by a specialised path (strength tracker,
 *    Garmin/FIT import, coaching) only touches rpe / feeling / pain / notes / session-RPE load:
 *    their measured duration, finish time, realised intensity and actual analysis are kept.
 */
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
    /** Feedback instant (default: now) and athlete timezone, to detect late feedback. */
    now?: Date;
    timezone?: string;
  },
): Promise<void> {
  const [w] = await db
    .select()
    .from(workouts)
    .where(and(eq(workouts.id, opts.workoutId), eq(workouts.userId, userId)))
    .limit(1);
  if (!w) throw new NotFoundError("Séance");
  const now = opts.now ?? new Date();
  const timezone = opts.timezone ?? "UTC";
  const alreadyDone = w.status === "done";
  const [planned] = await db
    .select()
    .from(workoutAnalyses)
    .where(and(eq(workoutAnalyses.workoutId, w.id), eq(workoutAnalyses.phase, "planned")))
    .limit(1);
  const [existingActual] = await db
    .select({ algorithmVersion: workoutAnalyses.algorithmVersion })
    .from(workoutAnalyses)
    .where(and(eq(workoutAnalyses.workoutId, w.id), eq(workoutAnalyses.phase, "actual")))
    .limit(1);
  // The actual row is ours when absent or produced by this planned-scaling path; strength_actual_v1,
  // activity_v1 and coach_session_v1 rows belong to their finisher and are never overwritten.
  const managedActual =
    !existingActual || existingActual.algorithmVersion.endsWith(`+${ACTUAL_SCALING_VERSION}`);
  const keepSpecialised = alreadyDone && !managedActual;

  const actualDurationMin = opts.actualDurationMin ?? w.actualDurationMin ?? null;
  const durationMin = actualDurationMin ?? w.plannedDurationMin ?? null;
  const load = durationMin != null ? sessionRpeLoad(durationMin, opts.rpe) : null;
  const scaled = planned
    ? scaleTemplateLoadToActual(planned.loadVector, {
        rpe: opts.rpe,
        expectedRpe: w.expectedRpe,
        actualMin: durationMin,
        plannedMin: w.plannedDurationMin,
      })
    : null;
  // A measured band (activity import: HR zones) is the floor; otherwise start from the plan.
  const baseBand =
    w.intensitySource === "CALCULATED" && w.realisedIntensity
      ? w.realisedIntensity
      : (planned?.intensity ?? w.realisedIntensity ?? w.plannedIntensity ?? null);
  const realisedIntensity = keepSpecialised
    ? w.realisedIntensity
    : (opts.realisedIntensity ??
      realisedBandFromFeedback(baseBand, {
        loadVector: scaled?.loadVector ?? null,
        rpe: opts.rpe,
        heavyStrength: planned?.heavyStrength ?? w.type === "strength",
      }));
  const intensitySource =
    !keepSpecialised && !opts.realisedIntensity && realisedIntensity !== baseBand
      ? "CALCULATED"
      : w.intensitySource;
  const lateFeedback = localDate(now, timezone) > w.date;
  const plannedEnd = new Date(
    (w.startAt ?? instantFor(w.date, 17 * 60, timezone)).getTime() + (durationMin ?? 0) * 60000,
  );
  const finishedAt = opts.finishedAt ?? w.finishedAt ?? (lateFeedback ? plannedEnd : now);

  await db
    .update(workouts)
    .set({
      status: "done",
      rpe: opts.rpe,
      feeling: opts.feeling,
      painReported: opts.painReported,
      notes: opts.notes ?? w.notes,
      sessionRpeLoad: keepSpecialised
        ? w.actualDurationMin != null
          ? sessionRpeLoad(w.actualDurationMin, opts.rpe)
          : load
        : load,
      ...(keepSpecialised
        ? {}
        : { actualDurationMin, finishedAt, realisedIntensity, intensitySource }),
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

  if (planned && scaled && managedActual) {
    const intensity = realisedIntensity ?? planned.intensity;
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
        intensity,
        heavyStrength: planned.heavyStrength,
        source: "CALCULATED",
        inputRef: planned.inputRef,
        algorithmVersion: `${planned.algorithmVersion}+${ACTUAL_SCALING_VERSION}`,
        confidence:
          scaled.estimated && planned.confidence === "HIGH" ? "MEDIUM" : planned.confidence,
      })
      .onConflictDoUpdate({
        target: [workoutAnalyses.workoutId, workoutAnalyses.phase],
        set: { loadVector: scaled.loadVector, intensity, computedAt: new Date() },
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
  const minute = w.startAt ? localMinute(w.startAt, timezone) : null;
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
  const now = new Date();
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
      finishedAt: backDatedFinish(opts.date, null, opts.durationMin, opts.timezone, now),
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

/**
 * Finish instant of a logged (done) session: the log time when logged on the day itself, else the
 * declared start + duration, else 17:00 local + duration on the session's date — never the log
 * time of a later day (residual fatigue decays from this instant).
 */
export function backDatedFinish(
  date: IsoDate,
  startAt: Date | null,
  durationMin: number,
  timezone: string,
  now: Date = new Date(),
): Date {
  if (startAt) return new Date(startAt.getTime() + durationMin * 60000);
  if (localDate(now, timezone) <= date) return now;
  return new Date(instantFor(date, 17 * 60, timezone).getTime() + durationMin * 60000);
}

export function funScoreOf(feeling: Feeling | null): number | null {
  return feeling ? FEELING_TO_FUN[feeling] : null;
}

export { analyzeWod };
