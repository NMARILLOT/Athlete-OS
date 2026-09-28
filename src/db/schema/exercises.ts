import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  Equipment,
  ExerciseCategory,
  MeasurementType,
  Modality,
  MovementPattern,
  MuscleGroup,
} from "../../domain/core/types";
import type { ExerciseCost } from "../../domain/exercises/types";
import { timestampColumns } from "./_helpers";
import { users } from "./users";

/**
 * Exercise catalog (DATA_MODEL.md §2). Global rows have `user_id = null`; user-defined rows
 * cascade with their owner. Seeded from `src/domain/exercises/catalog.ts` (see `src/db/seed.ts`).
 */
export const exercises = pgTable(
  "exercises",
  {
    /** Stable slug (`back_squat`), also the foreign key used everywhere. */
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    category: text("category").$type<ExerciseCategory>().notNull(),
    movementPattern: text("movement_pattern").$type<MovementPattern>().notNull(),
    secondaryPatterns: text("secondary_patterns")
      .array()
      .$type<MovementPattern[]>()
      .notNull()
      .default([]),
    primaryMuscles: text("primary_muscles").array().$type<MuscleGroup[]>().notNull().default([]),
    secondaryMuscles: text("secondary_muscles")
      .array()
      .$type<MuscleGroup[]>()
      .notNull()
      .default([]),
    equipment: text("equipment").array().$type<Equipment[]>().notNull().default([]),
    measurementType: text("measurement_type").$type<MeasurementType>().notNull(),
    defaultIncrementKg: numeric("default_increment_kg", { mode: "number" }),
    /** 1..5 */
    technicalDifficulty: integer("technical_difficulty").notNull().default(1),
    /** 0..3 */
    impactLevel: integer("impact_level").notNull().default(0),
    /** 0..3 */
    eccentricLoad: integer("eccentric_load").notNull().default(0),
    modality: text("modality").$type<Modality>(),
    isBenchmarkLift: boolean("is_benchmark_lift").notNull().default(false),
    cost: jsonb("cost").$type<ExerciseCost>().notNull(),
    /** Null = global catalog row. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    ...timestampColumns(),
  },
  (t) => [index("exercises_user_idx").on(t.userId)],
).enableRLS();

/**
 * `exercise_aliases` — normalised lowercase aliases (FR/EN, abbreviations). Unique `(alias)` among
 * global rows and `(user_id, alias)` among user rows (two partial unique indexes).
 */
export const exerciseAliases = pgTable(
  "exercise_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    alias: text("alias").notNull(),
    exerciseId: text("exercise_id")
      .notNull()
      .references(() => exercises.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("exercise_aliases_global_alias_uq")
      .on(t.alias)
      .where(sql`${t.userId} is null`),
    uniqueIndex("exercise_aliases_user_alias_uq")
      .on(t.userId, t.alias)
      .where(sql`${t.userId} is not null`),
    index("exercise_aliases_exercise_idx").on(t.exerciseId),
  ],
).enableRLS();
