import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { HrZone, HrZoneMethod } from "../../domain/cardio/zones";
import type { DataSource, IntensityBand, IntentKind } from "../../domain/core/types";
import type { EngineInput, Recommendation } from "../../domain/engine/types";
import type { StimulusTargets } from "../../domain/stimulus/targets";
import { userOwnedTable } from "./_helpers";
import { confidenceEnum } from "./enums";
import { trainingBlocks } from "./users";

/**
 * Stimulus targets & engine (DATA_MODEL.md §8, ADR-009).
 */

/** `user_intents.params` JSONB: structured intent parameters (`UserIntent` minus kind/rawText/date). */
export interface IntentParams {
  intensity?: IntensityBand | null;
  availableMinutes?: number | null;
  /** Free extra parameters for `custom` intents. */
  extra?: Record<string, string | number | boolean | null>;
}

/** `computed_metrics.scope` values. */
export const METRIC_SCOPE_VALUES = ["activity", "workout", "day", "week", "exercise"] as const;
export type MetricScope = (typeof METRIC_SCOPE_VALUES)[number];

/** `computed_metrics.inputs` JSONB: ids and parameters used by the computation (explainability). */
export type MetricInputs = Record<string, string | number | boolean | null | string[]>;

/** `athlete_model_params.payload` JSONB: structured value for non-scalar params (box priors…). */
export type AthleteModelPayload = Record<string, unknown>;

/** `weekly_stimulus_targets` — precedence USER > ENGINE. */
export const weeklyStimulusTargets = userOwnedTable(
  "weekly_stimulus_targets",
  {
    /** ISO week Monday. */
    weekStart: date("week_start").notNull(),
    targets: jsonb("targets").$type<StimulusTargets>().notNull(),
    /** `ENGINE | USER` */
    source: text("source").notNull(),
    blockId: uuid("block_id").references(() => trainingBlocks.id, { onDelete: "set null" }),
  },
  (t) => [
    uniqueIndex("weekly_stimulus_targets_user_week_source_uq").on(t.userId, t.weekStart, t.source),
  ],
);

/**
 * `recommendations` — versioned per `(user_id, date)`; exactly one non-superseded row per day.
 * Versioning is one transaction under `pg_advisory_xact_lock(hashtext(user_id))`.
 */
export const recommendations = userOwnedTable(
  "recommendations",
  {
    date: date("date").notNull(),
    version: integer("version").notNull().default(1),
    engineVersion: text("engine_version").notNull(),
    inputsSnapshot: jsonb("inputs_snapshot").$type<EngineInput>().notNull(),
    /** `Recommendation` incl. `weekOutlook`. */
    output: jsonb("output").$type<Recommendation>().notNull(),
    rulesTriggered: text("rules_triggered").array().notNull().default([]),
    explanation: text("explanation").notNull().default(""),
    confidence: confidenceEnum("confidence").notNull(),
    /** `primary | bonus | alt:<index>` — text on purpose (evolving). */
    acceptedOption: text("accepted_option"),
    superseded: boolean("superseded").notNull().default(false),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("recommendations_user_date_version_uq").on(t.userId, t.date, t.version),
    uniqueIndex("recommendations_user_date_current_uq")
      .on(t.userId, t.date)
      .where(sql`${t.superseded} = false`),
  ],
);

/** `user_intents` — "je vais au CrossFit", "envie de courir", … */
export const userIntents = userOwnedTable(
  "user_intents",
  {
    startsOn: date("starts_on").notNull(),
    /** Null = single day. */
    endsOn: date("ends_on"),
    kind: text("kind").$type<IntentKind>().notNull(),
    params: jsonb("params").$type<IntentParams>().notNull().default({}),
    rawText: text("raw_text"),
    /** `USER | AI_PARSED` */
    parsedBy: text("parsed_by").notNull().default("USER"),
    confidence: real("confidence"),
    /** `active | applied | declined | withdrawn` */
    status: text("status").notNull().default("active"),
    declaredAt: timestamp("declared_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("user_intents_user_starts_status_idx").on(t.userId, t.startsOn, t.status)],
);

/** `computed_metrics` — versioned; recompute = one transaction (supersede then insert). */
export const computedMetrics = userOwnedTable(
  "computed_metrics",
  {
    metric: text("metric").notNull(),
    scope: text("scope").$type<MetricScope>().notNull(),
    /** Activity / workout uuid, exercise slug, or null for day/week scopes. */
    scopeId: text("scope_id"),
    date: date("date").notNull(),
    value: doublePrecision("value").notNull(),
    unit: text("unit").notNull().default(""),
    algorithmVersion: text("algorithm_version").notNull(),
    inputs: jsonb("inputs").$type<MetricInputs>().notNull().default({}),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
    superseded: boolean("superseded").notNull().default(false),
  },
  (t) => [
    unique("computed_metrics_natural_uq")
      .on(t.userId, t.metric, t.scope, t.scopeId, t.date, t.algorithmVersion)
      .nullsNotDistinct(),
    index("computed_metrics_user_metric_scope_date_current_idx")
      .on(t.userId, t.metric, t.scope, t.date)
      .where(sql`${t.superseded} = false`),
  ],
);

/** `hr_zone_sets` — immutable; the latest `valid_from ≤ date` is the set for that date. */
export const hrZoneSets = userOwnedTable(
  "hr_zone_sets",
  {
    validFrom: date("valid_from").notNull(),
    method: text("method").$type<HrZoneMethod>().notNull(),
    lthr: integer("lthr"),
    maxHr: integer("max_hr"),
    restingHr: integer("resting_hr"),
    zones: jsonb("zones").$type<HrZone[]>().notNull(),
    source: text("source").$type<DataSource>().notNull(),
    confidence: confidenceEnum("confidence").notNull(),
  },
  (t) => [index("hr_zone_sets_user_valid_from_idx").on(t.userId, t.validFrom)],
);

/** `athlete_model_params` — learned overrides of the athlete-model defaults. */
export const athleteModelParams = userOwnedTable(
  "athlete_model_params",
  {
    /** `fatigue_half_life.muscular_lower`, `tolerance.impact`, `exercise_cost.wall_ball`, `box_prior.weekday.0`, … */
    key: text("key").notNull(),
    value: doublePrecision("value").notNull(),
    payload: jsonb("payload").$type<AthleteModelPayload>(),
    confidence: confidenceEnum("confidence").notNull().default("LOW"),
    evidenceCount: integer("evidence_count").notNull().default(0),
  },
  (t) => [uniqueIndex("athlete_model_params_user_key_uq").on(t.userId, t.key)],
);
