import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { DataSource } from "../../domain/core/types";
import type { NormalizedWod } from "../../domain/wod/schema";
import { timestampColumns, userOwnedTable } from "./_helpers";
import { activities } from "./activities";
import { confidenceEnum } from "./enums";
import { exercises } from "./exercises";
import { users } from "./users";
import { workouts } from "./workouts";

/**
 * Records, benchmarks, tests (DATA_MODEL.md §7).
 */

/** `personal_records.kind` values. */
export const PR_KIND_VALUES = [
  "weight",
  "reps",
  "e1rm",
  "time",
  "distance",
  "pace",
  "benchmark",
  "calories",
] as const;
export type PrKind = (typeof PR_KIND_VALUES)[number];

/** `benchmarks.score_kind` / `benchmark_results.score_kind`. */
export const BENCHMARK_SCORE_KIND_VALUES = ["time", "rounds_reps", "reps", "load"] as const;
export type BenchmarkScoreKind = (typeof BENCHMARK_SCORE_KIND_VALUES)[number];

/** `test_results.conditions` JSONB (weather, surface, shoes, fatigue…). */
export type TestConditions = Record<string, string | number | boolean | null>;

/**
 * `benchmarks` — global (`user_id = null`, seeded: Fran, Grace, …) or user-defined. `id` is a slug.
 */
export const benchmarks = pgTable(
  "benchmarks",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** `girl | hero | open | custom` */
    kind: text("kind").notNull(),
    description: text("description").notNull().default(""),
    scoreKind: text("score_kind").$type<BenchmarkScoreKind>().notNull(),
    normalizedWod: jsonb("normalized_wod").$type<NormalizedWod>(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    ...timestampColumns(),
  },
  (t) => [index("benchmarks_user_idx").on(t.userId)],
).enableRLS();

/**
 * `personal_records` — PR detection is a pure `detectPRs(history)`; the service upserts on the
 * nulls-not-distinct natural key.
 */
export const personalRecords = userOwnedTable(
  "personal_records",
  {
    kind: text("kind").$type<PrKind>().notNull(),
    exerciseId: text("exercise_id").references(() => exercises.id),
    benchmarkId: text("benchmark_id").references(() => benchmarks.id, { onDelete: "set null" }),
    /** `5k | 10k | 2k_row | …` */
    distanceKey: text("distance_key"),
    value: real("value").notNull(),
    unit: text("unit").notNull(),
    reps: integer("reps"),
    achievedAt: timestamp("achieved_at", { withTimezone: true }).notNull(),
    workoutId: uuid("workout_id").references(() => workouts.id, { onDelete: "set null" }),
    activityId: uuid("activity_id").references(() => activities.id, { onDelete: "set null" }),
    source: text("source").$type<DataSource>().notNull(),
    /** True for e1RM-based records. */
    estimated: boolean("estimated").notNull().default(false),
    algorithmVersion: text("algorithm_version"),
    superseded: boolean("superseded").notNull().default(false),
    previousValue: real("previous_value"),
  },
  (t) => [
    unique("personal_records_natural_uq")
      .on(
        t.userId,
        t.kind,
        t.exerciseId,
        t.benchmarkId,
        t.distanceKey,
        t.workoutId,
        t.activityId,
        t.algorithmVersion,
      )
      .nullsNotDistinct(),
    index("personal_records_user_kind_exercise_idx").on(t.userId, t.kind, t.exerciseId),
  ],
);

/** `benchmark_results` */
export const benchmarkResults = userOwnedTable(
  "benchmark_results",
  {
    benchmarkId: text("benchmark_id")
      .notNull()
      .references(() => benchmarks.id),
    workoutId: uuid("workout_id").references(() => workouts.id, { onDelete: "set null" }),
    date: date("date").notNull(),
    /** Seconds, rounds, reps or kg depending on `score_kind`. */
    scoreValue: real("score_value").notNull(),
    scoreKind: text("score_kind").$type<BenchmarkScoreKind>().notNull(),
    rx: boolean("rx").notNull().default(false),
    notes: text("notes").notNull().default(""),
  },
  (t) => [
    uniqueIndex("benchmark_results_user_benchmark_workout_uq").on(
      t.userId,
      t.benchmarkId,
      t.workoutId,
    ),
    index("benchmark_results_user_benchmark_date_idx").on(t.userId, t.benchmarkId, t.date),
  ],
);

/** `test_results` — 5 k run, 2 k row, LTHR tests… */
export const testResults = userOwnedTable(
  "test_results",
  {
    /** `test_run_5k | test_row_2k | lthr | …` */
    testKey: text("test_key").notNull(),
    date: date("date").notNull(),
    value: real("value").notNull(),
    unit: text("unit").notNull(),
    conditions: jsonb("conditions").$type<TestConditions>().notNull().default({}),
    activityId: uuid("activity_id").references(() => activities.id, { onDelete: "set null" }),
    workoutId: uuid("workout_id").references(() => workouts.id, { onDelete: "set null" }),
    source: text("source").$type<DataSource>().notNull(),
    confidence: confidenceEnum("confidence").notNull().default("HIGH"),
    algorithmVersion: text("algorithm_version"),
  },
  (t) => [
    unique("test_results_natural_uq")
      .on(t.userId, t.testKey, t.activityId, t.workoutId)
      .nullsNotDistinct(),
    index("test_results_user_key_date_idx").on(t.userId, t.testKey, t.date),
  ],
);
