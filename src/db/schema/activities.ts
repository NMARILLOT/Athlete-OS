import {
  date,
  index,
  integer,
  jsonb,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { TimeInZones } from "../../domain/cardio/zones";
import { userOwnedTable } from "./_helpers";
import { hrZoneSets } from "./engine";
import { workouts } from "./workouts";

/**
 * Activities — Garmin / FIT (DATA_MODEL.md §5, ADR-010).
 */

/** `activities.training_effect` JSONB (Garmin aerobic/anaerobic training effect). */
export interface TrainingEffect {
  aerobic?: number | null;
  anaerobic?: number | null;
  label?: string | null;
}

/** `activity_streams.stream` values. */
export const ACTIVITY_STREAM_VALUES = [
  "hr",
  "pace",
  "speed",
  "power",
  "cadence",
  "altitude",
  "distance",
  "gct",
  "vo",
  "stride",
] as const;
export type ActivityStream = (typeof ACTIVITY_STREAM_VALUES)[number];

/**
 * `raw_payloads` — vendor payloads are kept verbatim (JSONB or a storage path). `dedupe_key`
 * recipes: `garmin:activity:<summaryId>`, `fit:<sha256>`, `garmin:daily:<date>`,
 * `scale:<provider>:<measureId>`.
 */
export const rawPayloads = userOwnedTable(
  "raw_payloads",
  {
    provider: text("provider").notNull(),
    kind: text("kind").notNull(),
    externalId: text("external_id"),
    payload: jsonb("payload").$type<unknown>(),
    storagePath: text("storage_path"),
    parserVersion: text("parser_version"),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
    dedupeKey: text("dedupe_key").notNull(),
  },
  (t) => [uniqueIndex("raw_payloads_user_dedupe_uq").on(t.userId, t.dedupeKey)],
);

/**
 * `activities` — `fingerprint = ${sport}|${floor(start_epoch_s / 60)}` is unique per user
 * (merge on conflict, prefer `garmin` fields, keep the original `raw_payload_id`).
 */
export const activities = userOwnedTable(
  "activities",
  {
    /** `garmin | fit_import | manual` */
    provider: text("provider").notNull(),
    /** FIT: sha256 of the file bytes. */
    externalId: text("external_id"),
    fingerprint: text("fingerprint").notNull(),
    sport: text("sport").notNull(),
    subSport: text("sub_sport"),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    /** Computed at write time from the source's own local time. */
    localDate: date("local_date").notNull(),
    utcOffsetMin: integer("utc_offset_min"),
    durationSec: integer("duration_sec").notNull(),
    distanceM: real("distance_m"),
    avgHr: integer("avg_hr"),
    maxHr: integer("max_hr"),
    avgPaceSecKm: real("avg_pace_sec_km"),
    avgPowerW: real("avg_power_w"),
    avgCadence: real("avg_cadence"),
    elevationGainM: real("elevation_gain_m"),
    calories: integer("calories"),
    avgStrideLengthM: real("avg_stride_length_m"),
    avgGctMs: real("avg_gct_ms"),
    avgVerticalOscillationMm: real("avg_vertical_oscillation_mm"),
    avgVerticalRatio: real("avg_vertical_ratio"),
    gctBalance: real("gct_balance"),
    temperatureC: real("temperature_c"),
    deviceSerial: text("device_serial"),
    trainingEffect: jsonb("training_effect").$type<TrainingEffect>(),
    /** Zone set used at analysis time (ADR-009). */
    zoneSetId: uuid("zone_set_id").references(() => hrZoneSets.id, { onDelete: "set null" }),
    timeInZones: jsonb("time_in_zones").$type<TimeInZones>(),
    /** Null only for `manual` activities. */
    rawPayloadId: uuid("raw_payload_id").references(() => rawPayloads.id, {
      onDelete: "set null",
    }),
    parserVersion: text("parser_version").notNull(),
    /** N:1 — several activities may realise one planned workout. */
    workoutId: uuid("workout_id").references(() => workouts.id, { onDelete: "set null" }),
    comparableGroup: text("comparable_group"),
  },
  (t) => [
    uniqueIndex("activities_user_provider_external_uq").on(t.userId, t.provider, t.externalId),
    uniqueIndex("activities_user_fingerprint_uq").on(t.userId, t.fingerprint),
    index("activities_user_start_idx").on(t.userId, t.startAt),
    index("activities_user_local_date_idx").on(t.userId, t.localDate),
    index("activities_workout_idx").on(t.workoutId),
  ],
);

/** `activity_laps` */
export const activityLaps = userOwnedTable(
  "activity_laps",
  {
    activityId: uuid("activity_id")
      .notNull()
      .references(() => activities.id, { onDelete: "cascade" }),
    lapIndex: integer("lap_index").notNull(),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    durationSec: real("duration_sec").notNull(),
    distanceM: real("distance_m"),
    avgHr: integer("avg_hr"),
    maxHr: integer("max_hr"),
    avgPaceSecKm: real("avg_pace_sec_km"),
    avgPowerW: real("avg_power_w"),
    avgCadence: real("avg_cadence"),
    elevationGainM: real("elevation_gain_m"),
  },
  (t) => [uniqueIndex("activity_laps_activity_lap_uq").on(t.activityId, t.lapIndex)],
);

/** `activity_streams` — one resampled series per stream kind. */
export const activityStreams = userOwnedTable(
  "activity_streams",
  {
    activityId: uuid("activity_id")
      .notNull()
      .references(() => activities.id, { onDelete: "cascade" }),
    stream: text("stream").$type<ActivityStream>().notNull(),
    sampleIntervalSec: real("sample_interval_sec").notNull().default(1),
    values: jsonb("values").$type<Array<number | null>>().notNull().default([]),
    count: integer("count").notNull().default(0),
  },
  (t) => [uniqueIndex("activity_streams_activity_stream_uq").on(t.activityId, t.stream)],
);
