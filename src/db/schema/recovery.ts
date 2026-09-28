import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { DataSource, PainLocation } from "../../domain/core/types";
import type { ReadinessSummary } from "../../domain/readiness/types";
import { userOwnedTable } from "./_helpers";
import { rawPayloads } from "./activities";
import { confidenceEnum } from "./enums";

/**
 * Recovery, readiness, body, pain (DATA_MODEL.md §6).
 */

/** `body_compositions.extra` JSONB: provider-specific extras (visceral fat, BMR, …). */
export type BodyCompositionExtra = Record<string, number | string | boolean | null>;

/**
 * `daily_readiness` — **declared only** (three taps + unusual pain); measured values live in
 * `recovery_metrics` and are folded into `summary` when it is (re)computed. Declared fields are
 * nullable so a summary can exist for a day without a declaration.
 */
export const dailyReadiness = userOwnedTable(
  "daily_readiness",
  {
    date: date("date").notNull(),
    /** 1..3 */
    energy: integer("energy"),
    /** 0..3 */
    soreness: integer("soreness"),
    /** 1..3 */
    motivation: integer("motivation"),
    unusualPain: boolean("unusual_pain").notNull().default(false),
    note: text("note").notNull().default(""),
    declaredAt: timestamp("declared_at", { withTimezone: true }),
    summary: jsonb("summary").$type<ReadinessSummary>(),
  },
  (t) => [uniqueIndex("daily_readiness_user_date_uq").on(t.userId, t.date)],
);

/** `recovery_metrics` — one measured value per `(date, metric, source)`. */
export const recoveryMetrics = userOwnedTable(
  "recovery_metrics",
  {
    date: date("date").notNull(),
    /** `sleep_hours | sleep_score | resting_hr | hrv_rmssd | stress | body_battery | respiration | vo2max_est | lthr | …` */
    metric: text("metric").notNull(),
    value: real("value").notNull(),
    unit: text("unit").notNull().default(""),
    source: text("source").$type<DataSource>().notNull(),
    confidence: confidenceEnum("confidence").notNull().default("HIGH"),
    rawPayloadId: uuid("raw_payload_id").references(() => rawPayloads.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    uniqueIndex("recovery_metrics_user_date_metric_source_uq").on(
      t.userId,
      t.date,
      t.metric,
      t.source,
    ),
    index("recovery_metrics_user_metric_date_idx").on(t.userId, t.metric, t.date),
  ],
);

/** `body_compositions` — scale / Garmin / manual weigh-ins. */
export const bodyCompositions = userOwnedTable(
  "body_compositions",
  {
    measuredAt: timestamp("measured_at", { withTimezone: true }).notNull(),
    localDate: date("local_date").notNull(),
    weightKg: numeric("weight_kg", { mode: "number" }).notNull(),
    bodyFatPct: numeric("body_fat_pct", { mode: "number" }),
    muscleMassKg: numeric("muscle_mass_kg", { mode: "number" }),
    waterPct: numeric("water_pct", { mode: "number" }),
    boneMassKg: numeric("bone_mass_kg", { mode: "number" }),
    extra: jsonb("extra").$type<BodyCompositionExtra>().notNull().default({}),
    /** `SCALE | GARMIN | MANUAL` */
    source: text("source").notNull(),
    provider: text("provider"),
    externalId: text("external_id"),
    rawPayloadId: uuid("raw_payload_id").references(() => rawPayloads.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    uniqueIndex("body_compositions_user_source_external_uq").on(t.userId, t.source, t.externalId),
    uniqueIndex("body_compositions_user_manual_measured_uq")
      .on(t.userId, t.measuredAt)
      .where(sql`${t.source} = 'MANUAL'`),
    index("body_compositions_user_local_date_idx").on(t.userId, t.localDate),
  ],
);

/** `pain_logs` — active pains feed the engine's safety rules. */
export const painLogs = userOwnedTable(
  "pain_logs",
  {
    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
    location: text("location").$type<PainLocation>().notNull(),
    /** `left | right | both` */
    side: text("side"),
    /** 0..10 */
    intensity: integer("intensity").notNull(),
    movementSpecific: boolean("movement_specific").notNull().default(false),
    /** Exercise ids or movement patterns that provoke it. */
    movements: text("movements").array().notNull().default([]),
    sudden: boolean("sudden").notNull().default(false),
    persistent: boolean("persistent").notNull().default(false),
    /** `active | improving | resolved` */
    status: text("status").notNull().default("active"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    notes: text("notes").notNull().default(""),
  },
  (t) => [index("pain_logs_user_status_idx").on(t.userId, t.status)],
);
