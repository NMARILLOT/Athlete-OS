import {
  boolean,
  date,
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
import type { BlockFocus, GoalKey, Modality, StimulusKey } from "../../domain/core/types";
import { timestampColumns, userOwnedTable } from "./_helpers";
import { recommendations } from "./engine";

/**
 * Identity & profile (DATA_MODEL.md §1).
 */

/** `preferred_training_times` JSONB: athlete-local "HH:MM" per session family. */
export type PreferredTrainingTimes = Partial<Record<"crossfit" | "strength" | "cardio", string>>;

/** `facilities` JSONB. */
export interface Facilities {
  crossfitBox?: boolean;
  gym?: boolean;
  home?: boolean;
  pool?: boolean;
  track?: boolean;
}

/** `rest_timer_overrides` JSONB: seconds per set intent (`strength`, `hypertrophy`, …). */
export type RestTimerOverrides = Partial<Record<string, number>>;

/** `notification_settings` JSONB: named switches (`morningBrief`, `missingRpe`, …). */
export type NotificationSettings = Partial<Record<string, boolean>>;

/** `goals.target` JSONB: free-form goal target (event date, target time, lift target…). */
export type GoalTarget = Record<string, string | number | boolean | null>;

/**
 * `users` — `id` is the Supabase auth uid (or the local fixed uuid), so it is never generated
 * by the database. Not user-owned in the `userOwnedTable` sense but RLS-enabled like every table.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull().default(""),
    /** IANA timezone used to compute athlete-local day columns at write time. */
    timezone: text("timezone").notNull().default("Europe/Paris"),
    onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
    ...timestampColumns(),
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email)],
).enableRLS();

/** `athlete_profiles` — 1:1 with `users`. */
export const athleteProfiles = userOwnedTable(
  "athlete_profiles",
  {
    birthDate: date("birth_date"),
    heightCm: numeric("height_cm", { mode: "number" }),
    sex: text("sex"),
    restingHrManual: integer("resting_hr_manual"),
    maxHrManual: integer("max_hr_manual"),
    lthrManual: integer("lthr_manual"),
    /** Onboarding sets `today + 21 d`; the engine is conservative until then. */
    baselinePhaseUntil: date("baseline_phase_until"),
    weeklyHoursTarget: numeric("weekly_hours_target", { mode: "number" }).notNull().default(7),
    preferredTrainingTimes: jsonb("preferred_training_times")
      .$type<PreferredTrainingTimes>()
      .notNull()
      .default({}),
    equipment: text("equipment").array().notNull().default([]),
    facilities: jsonb("facilities").$type<Facilities>().notNull().default({}),
    /** Latest bodyweight, denormalised from `body_compositions`. */
    bodyweightKg: numeric("bodyweight_kg", { mode: "number" }),
  },
  (t) => [uniqueIndex("athlete_profiles_user_uq").on(t.userId)],
);

/** `user_preferences` — 1:1 with `users`. */
export const userPreferences = userOwnedTable(
  "user_preferences",
  {
    barbellIncrementKg: numeric("barbell_increment_kg", { mode: "number" }).notNull().default(2.5),
    dumbbellIncrementKg: numeric("dumbbell_increment_kg", { mode: "number" }).notNull().default(2),
    machineIncrementKg: numeric("machine_increment_kg", { mode: "number" }).notNull().default(2.5),
    restTimerOverrides: jsonb("rest_timer_overrides")
      .$type<RestTimerOverrides>()
      .notNull()
      .default({}),
    notificationSettings: jsonb("notification_settings")
      .$type<NotificationSettings>()
      .notNull()
      .default({}),
    compositeScoreEnabled: boolean("composite_score_enabled").notNull().default(false),
    favouriteModalities: text("favourite_modalities")
      .array()
      .$type<Modality[]>()
      .notNull()
      .default([]),
    dislikedModalities: text("disliked_modalities")
      .array()
      .$type<Modality[]>()
      .notNull()
      .default([]),
    maxHardSessionsPerWeek: integer("max_hard_sessions_per_week").notNull().default(3),
  },
  (t) => [uniqueIndex("user_preferences_user_uq").on(t.userId)],
);

/** `goals` — weighted goals feeding the stimulus targets. */
export const goals = userOwnedTable(
  "goals",
  {
    /** `long | medium | short`. */
    horizon: text("horizon").notNull(),
    key: text("key").$type<GoalKey>().notNull(),
    title: text("title").notNull(),
    /** 0..1 */
    weight: numeric("weight", { mode: "number" }).notNull().default(1),
    target: jsonb("target").$type<GoalTarget>().notNull().default({}),
    active: boolean("active").notNull().default(true),
    startsOn: date("starts_on"),
    endsOn: date("ends_on"),
  },
  (t) => [index("goals_user_active_idx").on(t.userId, t.active)],
);

/** `training_blocks` — a `focus = recovery` block is the persisted deload state. */
export const trainingBlocks = userOwnedTable(
  "training_blocks",
  {
    name: text("name").notNull(),
    focus: text("focus").$type<BlockFocus>().notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on"),
    stimulusTargets: jsonb("stimulus_targets").$type<Partial<Record<StimulusKey, number>>>(),
    /** `USER | ENGINE` */
    source: text("source").notNull().default("USER"),
    reason: text("reason"),
    rulesTriggered: text("rules_triggered").array().notNull().default([]),
    recommendationId: uuid("recommendation_id").references(() => recommendations.id, {
      onDelete: "set null",
    }),
    /** `USER | ENGINE | EXPIRED` */
    endedBy: text("ended_by"),
    notes: text("notes").notNull().default(""),
  },
  (t) => [index("training_blocks_user_starts_idx").on(t.userId, t.startsOn)],
);
