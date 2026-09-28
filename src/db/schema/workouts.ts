import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  CardioKind,
  EnergySystem,
  Feeling,
  IntensityBand,
  LoadVector,
  Modality,
  MuscleExposure,
  PatternExposure,
  StimulusCredits,
} from "../../domain/core/types";
import type { CardioStep, CardioWorkoutSpec } from "../../domain/cardio/builder";
import type { StrengthTemplate } from "../../domain/strength/templates";
import type { SetQuality, StrengthPrescription } from "../../domain/strength/types";
import type { NormalizedWod, WodMovement } from "../../domain/wod/schema";
import type { TimeDomain } from "../../domain/wod/types";
import { timestampColumns, userOwnedTable } from "./_helpers";
import {
  analysisPhaseEnum,
  confidenceEnum,
  workoutSourceEnum,
  workoutStatusEnum,
  workoutTypeEnum,
} from "./enums";
import { hrZoneSets, recommendations } from "./engine";
import { exercises } from "./exercises";
import { wodInboxItems } from "./inbox";
import { benchmarks } from "./records";
import { users } from "./users";

/**
 * Unified workouts (DATA_MODEL.md §3, ADR-013).
 */

/** `workout_exercises.prescription`: a strength prescription or the parsed WOD quantities. */
export type WorkoutExercisePrescription = StrengthPrescription | WodMovement;

/** `crossfit_workouts.score` JSONB. */
export interface CrossfitScore {
  kind: "time" | "rounds_reps" | "reps" | "load";
  /** Seconds (`time`), rounds (`rounds_reps`), reps or kg. */
  value: number;
  /** Extra reps for `rounds_reps` scores ("12 rounds + 7"). */
  extraReps?: number | null;
  rx: boolean;
  scaledNotes?: string | null;
}

/** `workout_templates.body` JSONB. */
export type WorkoutTemplateBody = StrengthTemplate | CardioWorkoutSpec;

/**
 * `workouts` — **single calendar truth**. `id` is client-generatable (offline strength sessions);
 * the server upserts by `(id, user_id)`.
 */
export const workouts = userOwnedTable(
  "workouts",
  {
    type: workoutTypeEnum("type").notNull(),
    source: workoutSourceEnum("source").notNull(),
    status: workoutStatusEnum("status").notNull().default("planned"),
    /** Athlete-local day, computed at write time. */
    date: date("date").notNull(),
    startAt: timestamp("start_at", { withTimezone: true }),
    plannedDurationMin: integer("planned_duration_min"),
    actualDurationMin: integer("actual_duration_min"),
    title: text("title").notNull(),
    plannedIntensity: text("planned_intensity").$type<IntensityBand>(),
    realisedIntensity: text("realised_intensity").$type<IntensityBand>(),
    /** `ENGINE | USER | CALCULATED | AI_PARSED` */
    intensitySource: text("intensity_source").notNull().default("USER"),
    /** 1..10 */
    rpe: numeric("rpe", { mode: "number" }),
    /** The numeric fun score is derived in code by `FEELING_TO_FUN`. */
    feeling: text("feeling").$type<Feeling>(),
    painReported: boolean("pain_reported").notNull().default(false),
    notes: text("notes").notNull().default(""),
    templateId: uuid("template_id").references(() => workoutTemplates.id, {
      onDelete: "set null",
    }),
    recommendationId: uuid("recommendation_id").references(() => recommendations.id, {
      onDelete: "set null",
    }),
    /** Session-RPE load (AU) = RPE × minutes, written when the session is done. */
    sessionRpeLoad: numeric("session_rpe_load", { mode: "number" }),
    /** Fixed = class time / coaching / event: the engine plans around it, never removes it. */
    fixed: boolean("fixed").notNull().default(false),
    expectedRpe: numeric("expected_rpe", { mode: "number" }),
    clientUpdatedAt: timestamp("client_updated_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("workouts_user_date_idx").on(t.userId, t.date),
    index("workouts_user_status_date_idx").on(t.userId, t.status, t.date),
  ],
);

/** `workout_exercises` — valid for **every** workout type; materialised from `NormalizedWod` on inbox confirmation. */
export const workoutExercises = userOwnedTable(
  "workout_exercises",
  {
    workoutId: uuid("workout_id")
      .notNull()
      .references(() => workouts.id, { onDelete: "cascade" }),
    /** Denormalised from the workout. */
    date: date("date").notNull(),
    order: integer("order").notNull().default(0),
    blockIndex: integer("block_index"),
    exerciseId: text("exercise_id")
      .notNull()
      .references(() => exercises.id),
    prescription: jsonb("prescription").$type<WorkoutExercisePrescription>().notNull(),
    /** `AI_PARSED | USER | ENGINE` */
    source: text("source").notNull().default("USER"),
    /** Resolution confidence 0..1 when AI-parsed. */
    confidence: real("confidence"),
    supersetGroup: integer("superset_group"),
  },
  (t) => [
    index("workout_exercises_user_exercise_date_idx").on(t.userId, t.exerciseId, t.date),
    index("workout_exercises_workout_idx").on(t.workoutId, t.order),
  ],
);

/** `strength_sets` — client-generated ids, hard delete (no dependants). */
export const strengthSets = userOwnedTable(
  "strength_sets",
  {
    workoutExerciseId: uuid("workout_exercise_id")
      .notNull()
      .references(() => workoutExercises.id, { onDelete: "cascade" }),
    workoutId: uuid("workout_id")
      .notNull()
      .references(() => workouts.id, { onDelete: "cascade" }),
    exerciseId: text("exercise_id")
      .notNull()
      .references(() => exercises.id),
    date: date("date").notNull(),
    /** Display order, non-unique. */
    setIndex: integer("set_index").notNull().default(0),
    reps: integer("reps"),
    weightKg: numeric("weight_kg", { mode: "number" }),
    addedWeightKg: numeric("added_weight_kg", { mode: "number" }),
    durationSec: integer("duration_sec"),
    distanceM: numeric("distance_m", { mode: "number" }),
    calories: integer("calories"),
    heightCm: numeric("height_cm", { mode: "number" }),
    rpe: numeric("rpe", { mode: "number" }),
    rir: numeric("rir", { mode: "number" }),
    quality: text("quality").$type<SetQuality>(),
    isWarmup: boolean("is_warmup").notNull().default(false),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
    clientUpdatedAt: timestamp("client_updated_at", { withTimezone: true }).notNull().defaultNow(),
    e1rmKg: numeric("e1rm_kg", { mode: "number" }),
    e1rmVersion: text("e1rm_version"),
  },
  (t) => [
    index("strength_sets_user_exercise_completed_idx").on(t.userId, t.exerciseId, t.completedAt),
    index("strength_sets_workout_exercise_idx").on(t.workoutExerciseId),
  ],
);

/** `cardio_workouts` — 1:1 with a `cardio` workout. */
export const cardioWorkouts = userOwnedTable(
  "cardio_workouts",
  {
    workoutId: uuid("workout_id")
      .notNull()
      .references(() => workouts.id, { onDelete: "cascade" }),
    modality: text("modality").$type<Modality>().notNull(),
    workoutKind: text("workout_kind").$type<CardioKind>().notNull(),
    steps: jsonb("steps").$type<CardioStep[]>().notNull().default([]),
    zoneSetId: uuid("zone_set_id").references(() => hrZoneSets.id, { onDelete: "set null" }),
    garminWorkoutId: text("garmin_workout_id"),
    /** `not_sent | pending | synced | failed` */
    garminSyncStatus: text("garmin_sync_status").notNull().default("not_sent"),
    garminScheduledFor: date("garmin_scheduled_for"),
    lastSyncError: text("last_sync_error"),
  },
  (t) => [uniqueIndex("cardio_workouts_workout_uq").on(t.workoutId)],
);

/** `crossfit_workouts` — 1:1 with a `crossfit` workout. */
export const crossfitWorkouts = userOwnedTable(
  "crossfit_workouts",
  {
    workoutId: uuid("workout_id")
      .notNull()
      .references(() => workouts.id, { onDelete: "cascade" }),
    wodInboxItemId: uuid("wod_inbox_item_id").references(() => wodInboxItems.id, {
      onDelete: "set null",
    }),
    /** Display / raw structure (`NormalizedWod`). */
    normalizedWod: jsonb("normalized_wod").$type<NormalizedWod>(),
    score: jsonb("score").$type<CrossfitScore>(),
    benchmarkId: text("benchmark_id").references(() => benchmarks.id, { onDelete: "set null" }),
    timeDomain: text("time_domain").$type<TimeDomain>(),
  },
  (t) => [uniqueIndex("crossfit_workouts_workout_uq").on(t.workoutId)],
);

/** `coach_sessions` — 1:1 with a `coach_session` workout. */
export const coachSessions = userOwnedTable(
  "coach_sessions",
  {
    workoutId: uuid("workout_id")
      .notNull()
      .references(() => workouts.id, { onDelete: "cascade" }),
    /** `none | light | moderate | heavy` */
    demoLevel: text("demo_level").notNull().default("none"),
    standingMinutes: integer("standing_minutes").notNull().default(0),
    /** 1..5 */
    perceivedFatigue: integer("perceived_fatigue"),
  },
  (t) => [uniqueIndex("coach_sessions_workout_uq").on(t.workoutId)],
);

/**
 * `workout_templates` — global (`user_id = null`, seeded from `STRENGTH_TEMPLATES`) or user-owned.
 * `key` is the stable slug the engine refers to (`Option.templateId`, e.g. `lower_a`) and the
 * natural key of the idempotent seed: unique `(user_id, key)` NULLS NOT DISTINCT.
 */
export const workoutTemplates = pgTable(
  "workout_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    /** Workout family the template instantiates: `strength | cardio | crossfit | mobility`. */
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    body: jsonb("body").$type<WorkoutTemplateBody>().notNull(),
    expectedCredits: jsonb("expected_credits").$type<StimulusCredits>().notNull().default({}),
    expectedLoad: jsonb("expected_load").$type<LoadVector>().notNull(),
    expectedRpe: numeric("expected_rpe", { mode: "number" }),
    defaultDurationMin: integer("default_duration_min").notNull(),
    intensity: text("intensity").$type<IntensityBand>().notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    ...timestampColumns(),
  },
  (t) => [unique("workout_templates_user_key_uq").on(t.userId, t.key).nullsNotDistinct()],
).enableRLS();

/**
 * `workout_analyses` — one row per `(workout_id, phase)`. `planned` is written at creation,
 * `actual` when the workout is done; the stimulus ledger reads `actual` rows (ADR-013).
 */
export const workoutAnalyses = userOwnedTable(
  "workout_analyses",
  {
    workoutId: uuid("workout_id")
      .notNull()
      .references(() => workouts.id, { onDelete: "cascade" }),
    phase: analysisPhaseEnum("phase").notNull(),
    date: date("date").notNull(),
    stimulusCredits: jsonb("stimulus_credits").$type<StimulusCredits>().notNull().default({}),
    loadVector: jsonb("load_vector").$type<LoadVector>().notNull(),
    patternExposure: jsonb("pattern_exposure").$type<PatternExposure>().notNull().default({}),
    muscleExposure: jsonb("muscle_exposure").$type<MuscleExposure>().notNull().default({}),
    energySystems: text("energy_systems").array().$type<EnergySystem[]>().notNull().default([]),
    impactUnits: real("impact_units").notNull().default(0),
    intensity: text("intensity").$type<IntensityBand>().notNull(),
    heavyStrength: boolean("heavy_strength").notNull().default(false),
    /** `CALCULATED | AI_PARSED | ENGINE` */
    source: text("source").notNull(),
    /** Inbox item id / template id / input hash. */
    inputRef: text("input_ref"),
    algorithmVersion: text("algorithm_version").notNull(),
    confidence: confidenceEnum("confidence").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("workout_analyses_workout_phase_uq").on(t.workoutId, t.phase),
    index("workout_analyses_user_date_phase_idx").on(t.userId, t.date, t.phase),
  ],
);
