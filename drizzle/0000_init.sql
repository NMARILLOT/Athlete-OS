CREATE TYPE "public"."analysis_phase" AS ENUM('planned', 'actual');--> statement-breakpoint
CREATE TYPE "public"."confidence" AS ENUM('HIGH', 'MEDIUM', 'LOW');--> statement-breakpoint
CREATE TYPE "public"."inbox_status" AS ENUM('new', 'parsed', 'needs_review', 'confirmed', 'discarded');--> statement-breakpoint
CREATE TYPE "public"."sync_job_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."workout_source" AS ENUM('planned_engine', 'planned_user', 'manual', 'garmin', 'fit_import', 'wod_inbox');--> statement-breakpoint
CREATE TYPE "public"."workout_status" AS ENUM('planned', 'in_progress', 'done', 'skipped', 'auto_adjusted');--> statement-breakpoint
CREATE TYPE "public"."workout_type" AS ENUM('strength', 'cardio', 'crossfit', 'coach_session', 'mobility', 'free', 'rest');--> statement-breakpoint
CREATE TABLE "athlete_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"birth_date" date,
	"height_cm" numeric,
	"sex" text,
	"resting_hr_manual" integer,
	"max_hr_manual" integer,
	"lthr_manual" integer,
	"baseline_phase_until" date,
	"weekly_hours_target" numeric DEFAULT 7 NOT NULL,
	"preferred_training_times" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"equipment" text[] DEFAULT '{}' NOT NULL,
	"facilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bodyweight_kg" numeric
);
--> statement-breakpoint
ALTER TABLE "athlete_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"horizon" text NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"weight" numeric DEFAULT 1 NOT NULL,
	"target" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"starts_on" date,
	"ends_on" date
);
--> statement-breakpoint
ALTER TABLE "goals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "training_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"focus" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"stimulus_targets" jsonb,
	"source" text DEFAULT 'USER' NOT NULL,
	"reason" text,
	"rules_triggered" text[] DEFAULT '{}' NOT NULL,
	"recommendation_id" uuid,
	"ended_by" text,
	"notes" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "training_blocks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"barbell_increment_kg" numeric DEFAULT 2.5 NOT NULL,
	"dumbbell_increment_kg" numeric DEFAULT 2 NOT NULL,
	"machine_increment_kg" numeric DEFAULT 2.5 NOT NULL,
	"rest_timer_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notification_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"composite_score_enabled" boolean DEFAULT false NOT NULL,
	"favourite_modalities" text[] DEFAULT '{}' NOT NULL,
	"disliked_modalities" text[] DEFAULT '{}' NOT NULL,
	"max_hard_sessions_per_week" integer DEFAULT 3 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"timezone" text DEFAULT 'Europe/Paris' NOT NULL,
	"onboarding_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "exercise_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alias" text NOT NULL,
	"exercise_id" text NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "exercise_aliases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "exercises" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"movement_pattern" text NOT NULL,
	"secondary_patterns" text[] DEFAULT '{}' NOT NULL,
	"primary_muscles" text[] DEFAULT '{}' NOT NULL,
	"secondary_muscles" text[] DEFAULT '{}' NOT NULL,
	"equipment" text[] DEFAULT '{}' NOT NULL,
	"measurement_type" text NOT NULL,
	"default_increment_kg" numeric,
	"technical_difficulty" integer DEFAULT 1 NOT NULL,
	"impact_level" integer DEFAULT 0 NOT NULL,
	"eccentric_load" integer DEFAULT 0 NOT NULL,
	"modality" text,
	"is_benchmark_lift" boolean DEFAULT false NOT NULL,
	"cost" jsonb NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "exercises" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cardio_workouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workout_id" uuid NOT NULL,
	"modality" text NOT NULL,
	"workout_kind" text NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"zone_set_id" uuid,
	"garmin_workout_id" text,
	"garmin_sync_status" text DEFAULT 'not_sent' NOT NULL,
	"garmin_scheduled_for" date,
	"last_sync_error" text
);
--> statement-breakpoint
ALTER TABLE "cardio_workouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "coach_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workout_id" uuid NOT NULL,
	"demo_level" text DEFAULT 'none' NOT NULL,
	"standing_minutes" integer DEFAULT 0 NOT NULL,
	"perceived_fatigue" integer
);
--> statement-breakpoint
ALTER TABLE "coach_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "crossfit_workouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workout_id" uuid NOT NULL,
	"wod_inbox_item_id" uuid,
	"normalized_wod" jsonb,
	"score" jsonb,
	"benchmark_id" text,
	"time_domain" text
);
--> statement-breakpoint
ALTER TABLE "crossfit_workouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "strength_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workout_exercise_id" uuid NOT NULL,
	"workout_id" uuid NOT NULL,
	"exercise_id" text NOT NULL,
	"date" date NOT NULL,
	"set_index" integer DEFAULT 0 NOT NULL,
	"reps" integer,
	"weight_kg" numeric,
	"added_weight_kg" numeric,
	"duration_sec" integer,
	"distance_m" numeric,
	"calories" integer,
	"height_cm" numeric,
	"rpe" numeric,
	"rir" numeric,
	"quality" text,
	"is_warmup" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"client_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"e1rm_kg" numeric,
	"e1rm_version" text
);
--> statement-breakpoint
ALTER TABLE "strength_sets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workout_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workout_id" uuid NOT NULL,
	"phase" "analysis_phase" NOT NULL,
	"date" date NOT NULL,
	"stimulus_credits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"load_vector" jsonb NOT NULL,
	"pattern_exposure" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"muscle_exposure" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"energy_systems" text[] DEFAULT '{}' NOT NULL,
	"impact_units" real DEFAULT 0 NOT NULL,
	"intensity" text NOT NULL,
	"heavy_strength" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"input_ref" text,
	"algorithm_version" text NOT NULL,
	"confidence" "confidence" NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workout_analyses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workout_exercises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workout_id" uuid NOT NULL,
	"date" date NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"block_index" integer,
	"exercise_id" text NOT NULL,
	"prescription" jsonb NOT NULL,
	"source" text DEFAULT 'USER' NOT NULL,
	"confidence" real,
	"superset_group" integer
);
--> statement-breakpoint
ALTER TABLE "workout_exercises" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workout_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"body" jsonb NOT NULL,
	"expected_credits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expected_load" jsonb NOT NULL,
	"expected_rpe" numeric,
	"default_duration_min" integer NOT NULL,
	"intensity" text NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workout_templates_user_key_uq" UNIQUE NULLS NOT DISTINCT("user_id","key")
);
--> statement-breakpoint
ALTER TABLE "workout_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"type" "workout_type" NOT NULL,
	"source" "workout_source" NOT NULL,
	"status" "workout_status" DEFAULT 'planned' NOT NULL,
	"date" date NOT NULL,
	"start_at" timestamp with time zone,
	"planned_duration_min" integer,
	"actual_duration_min" integer,
	"title" text NOT NULL,
	"planned_intensity" text,
	"realised_intensity" text,
	"intensity_source" text DEFAULT 'USER' NOT NULL,
	"rpe" numeric,
	"feeling" text,
	"pain_reported" boolean DEFAULT false NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"template_id" uuid,
	"recommendation_id" uuid,
	"session_rpe_load" numeric,
	"fixed" boolean DEFAULT false NOT NULL,
	"expected_rpe" numeric,
	"client_updated_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "workouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ai_invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_hash" text NOT NULL,
	"output" jsonb,
	"valid" boolean DEFAULT false NOT NULL,
	"error" text,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_invocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "wod_inbox_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"input_kind" text NOT NULL,
	"raw_text" text,
	"image_path" text,
	"content_hash" text NOT NULL,
	"status" "inbox_status" DEFAULT 'new' NOT NULL,
	"normalized_wod" jsonb,
	"parse_source" text,
	"parse_confidence" real,
	"analysis" jsonb,
	"analysis_version" text,
	"last_error" text,
	"scheduled_for" date,
	"start_local" time,
	"workout_id" uuid
);
--> statement-breakpoint
ALTER TABLE "wod_inbox_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" text NOT NULL,
	"external_id" text,
	"fingerprint" text NOT NULL,
	"sport" text NOT NULL,
	"sub_sport" text,
	"start_at" timestamp with time zone NOT NULL,
	"local_date" date NOT NULL,
	"utc_offset_min" integer,
	"duration_sec" integer NOT NULL,
	"distance_m" real,
	"avg_hr" integer,
	"max_hr" integer,
	"avg_pace_sec_km" real,
	"avg_power_w" real,
	"avg_cadence" real,
	"elevation_gain_m" real,
	"calories" integer,
	"avg_stride_length_m" real,
	"avg_gct_ms" real,
	"avg_vertical_oscillation_mm" real,
	"avg_vertical_ratio" real,
	"gct_balance" real,
	"temperature_c" real,
	"device_serial" text,
	"training_effect" jsonb,
	"zone_set_id" uuid,
	"time_in_zones" jsonb,
	"raw_payload_id" uuid,
	"parser_version" text NOT NULL,
	"workout_id" uuid,
	"comparable_group" text
);
--> statement-breakpoint
ALTER TABLE "activities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "activity_laps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activity_id" uuid NOT NULL,
	"lap_index" integer NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"duration_sec" real NOT NULL,
	"distance_m" real,
	"avg_hr" integer,
	"max_hr" integer,
	"avg_pace_sec_km" real,
	"avg_power_w" real,
	"avg_cadence" real,
	"elevation_gain_m" real
);
--> statement-breakpoint
ALTER TABLE "activity_laps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "activity_streams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activity_id" uuid NOT NULL,
	"stream" text NOT NULL,
	"sample_interval_sec" real DEFAULT 1 NOT NULL,
	"values" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_streams" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "raw_payloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"external_id" text,
	"payload" jsonb,
	"storage_path" text,
	"parser_version" text,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dedupe_key" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "raw_payloads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "body_compositions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"measured_at" timestamp with time zone NOT NULL,
	"local_date" date NOT NULL,
	"weight_kg" numeric NOT NULL,
	"body_fat_pct" numeric,
	"muscle_mass_kg" numeric,
	"water_pct" numeric,
	"bone_mass_kg" numeric,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text NOT NULL,
	"provider" text,
	"external_id" text,
	"raw_payload_id" uuid
);
--> statement-breakpoint
ALTER TABLE "body_compositions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "daily_readiness" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"date" date NOT NULL,
	"energy" integer,
	"soreness" integer,
	"motivation" integer,
	"unusual_pain" boolean DEFAULT false NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"declared_at" timestamp with time zone,
	"summary" jsonb
);
--> statement-breakpoint
ALTER TABLE "daily_readiness" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pain_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"location" text NOT NULL,
	"side" text,
	"intensity" integer NOT NULL,
	"movement_specific" boolean DEFAULT false NOT NULL,
	"movements" text[] DEFAULT '{}' NOT NULL,
	"sudden" boolean DEFAULT false NOT NULL,
	"persistent" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"resolved_at" timestamp with time zone,
	"notes" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pain_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "recovery_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"date" date NOT NULL,
	"metric" text NOT NULL,
	"value" real NOT NULL,
	"unit" text DEFAULT '' NOT NULL,
	"source" text NOT NULL,
	"confidence" "confidence" DEFAULT 'HIGH' NOT NULL,
	"raw_payload_id" uuid
);
--> statement-breakpoint
ALTER TABLE "recovery_metrics" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "benchmark_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"benchmark_id" text NOT NULL,
	"workout_id" uuid,
	"date" date NOT NULL,
	"score_value" real NOT NULL,
	"score_kind" text NOT NULL,
	"rx" boolean DEFAULT false NOT NULL,
	"notes" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "benchmark_results" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "benchmarks" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"score_kind" text NOT NULL,
	"normalized_wod" jsonb,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "benchmarks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "personal_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"exercise_id" text,
	"benchmark_id" text,
	"distance_key" text,
	"value" real NOT NULL,
	"unit" text NOT NULL,
	"reps" integer,
	"achieved_at" timestamp with time zone NOT NULL,
	"workout_id" uuid,
	"activity_id" uuid,
	"source" text NOT NULL,
	"estimated" boolean DEFAULT false NOT NULL,
	"algorithm_version" text,
	"superseded" boolean DEFAULT false NOT NULL,
	"previous_value" real,
	CONSTRAINT "personal_records_natural_uq" UNIQUE NULLS NOT DISTINCT("user_id","kind","exercise_id","benchmark_id","distance_key","workout_id","activity_id","algorithm_version")
);
--> statement-breakpoint
ALTER TABLE "personal_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "test_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"test_key" text NOT NULL,
	"date" date NOT NULL,
	"value" real NOT NULL,
	"unit" text NOT NULL,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"activity_id" uuid,
	"workout_id" uuid,
	"source" text NOT NULL,
	"confidence" "confidence" DEFAULT 'HIGH' NOT NULL,
	"algorithm_version" text,
	CONSTRAINT "test_results_natural_uq" UNIQUE NULLS NOT DISTINCT("user_id","test_key","activity_id","workout_id")
);
--> statement-breakpoint
ALTER TABLE "test_results" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "athlete_model_params" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"key" text NOT NULL,
	"value" double precision NOT NULL,
	"payload" jsonb,
	"confidence" "confidence" DEFAULT 'LOW' NOT NULL,
	"evidence_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "athlete_model_params" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "computed_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metric" text NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text,
	"date" date NOT NULL,
	"value" double precision NOT NULL,
	"unit" text DEFAULT '' NOT NULL,
	"algorithm_version" text NOT NULL,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded" boolean DEFAULT false NOT NULL,
	CONSTRAINT "computed_metrics_natural_uq" UNIQUE NULLS NOT DISTINCT("user_id","metric","scope","scope_id","date","algorithm_version")
);
--> statement-breakpoint
ALTER TABLE "computed_metrics" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_zone_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_from" date NOT NULL,
	"method" text NOT NULL,
	"lthr" integer,
	"max_hr" integer,
	"resting_hr" integer,
	"zones" jsonb NOT NULL,
	"source" text NOT NULL,
	"confidence" "confidence" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hr_zone_sets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"date" date NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"engine_version" text NOT NULL,
	"inputs_snapshot" jsonb NOT NULL,
	"output" jsonb NOT NULL,
	"rules_triggered" text[] DEFAULT '{}' NOT NULL,
	"explanation" text DEFAULT '' NOT NULL,
	"confidence" "confidence" NOT NULL,
	"accepted_option" text,
	"superseded" boolean DEFAULT false NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recommendations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"kind" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw_text" text,
	"parsed_by" text DEFAULT 'USER' NOT NULL,
	"confidence" real,
	"status" text DEFAULT 'active' NOT NULL,
	"declared_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_intents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "weekly_stimulus_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"week_start" date NOT NULL,
	"targets" jsonb NOT NULL,
	"source" text NOT NULL,
	"block_id" uuid
);
--> statement-breakpoint
ALTER TABLE "weekly_stimulus_targets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "availability_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"weekday" integer,
	"date" date,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	"kind" text DEFAULT 'available' NOT NULL,
	"source" text DEFAULT 'USER' NOT NULL,
	"external_id" text,
	"label" text
);
--> statement-breakpoint
ALTER TABLE "availability_windows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"date" date NOT NULL,
	"priority" text DEFAULT 'B' NOT NULL,
	"taper_days" integer DEFAULT 0 NOT NULL,
	"notes" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "travel_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"destination" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"timezone" text,
	"equipment" text[] DEFAULT '{}' NOT NULL,
	"crossfit_access" boolean DEFAULT false NOT NULL,
	"gym_access" boolean DEFAULT false NOT NULL,
	"running_ok" boolean DEFAULT true NOT NULL,
	"bike_ok" boolean DEFAULT false NOT NULL,
	"notes" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "travel_periods" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "client_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workout_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"credentials_encrypted" "bytea",
	"external_user_id" text,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"connected_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "integrations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sync_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" "sync_job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"leased_until" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sync_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "athlete_profiles" ADD CONSTRAINT "athlete_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_blocks" ADD CONSTRAINT "training_blocks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_blocks" ADD CONSTRAINT "training_blocks_recommendation_id_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."recommendations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exercise_aliases" ADD CONSTRAINT "exercise_aliases_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exercise_aliases" ADD CONSTRAINT "exercise_aliases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exercises" ADD CONSTRAINT "exercises_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cardio_workouts" ADD CONSTRAINT "cardio_workouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cardio_workouts" ADD CONSTRAINT "cardio_workouts_workout_id_workouts_id_fk" FOREIGN KEY ("workout_id") REFERENCES "public"."workouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cardio_workouts" ADD CONSTRAINT "cardio_workouts_zone_set_id_hr_zone_sets_id_fk" FOREIGN KEY ("zone_set_id") REFERENCES "public"."hr_zone_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_sessions" ADD CONSTRAINT "coach_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_sessions" ADD CONSTRAINT "coach_sessions_workout_id_workouts_id_fk" FOREIGN KEY ("workout_id") REFERENCES "public"."workouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crossfit_workouts" ADD CONSTRAINT "crossfit_workouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crossfit_workouts" ADD CONSTRAINT "crossfit_workouts_workout_id_workouts_id_fk" FOREIGN KEY ("workout_id") REFERENCES "public"."workouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crossfit_workouts" ADD CONSTRAINT "crossfit_workouts_wod_inbox_item_id_wod_inbox_items_id_fk" FOREIGN KEY ("wod_inbox_item_id") REFERENCES "public"."wod_inbox_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crossfit_workouts" ADD CONSTRAINT "crossfit_workouts_benchmark_id_benchmarks_id_fk" FOREIGN KEY ("benchmark_id") REFERENCES "public"."benchmarks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strength_sets" ADD CONSTRAINT "strength_sets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strength_sets" ADD CONSTRAINT "strength_sets_workout_exercise_id_workout_exercises_id_fk" FOREIGN KEY ("workout_exercise_id") REFERENCES "public"."workout_exercises"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strength_sets" ADD CONSTRAINT "strength_sets_workout_id_workouts_id_fk" FOREIGN KEY ("workout_id") REFERENCES "public"."workouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strength_sets" ADD CONSTRAINT "strength_sets_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_analyses" ADD CONSTRAINT "workout_analyses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_analyses" ADD CONSTRAINT "workout_analyses_workout_id_workouts_id_fk" FOREIGN KEY ("workout_id") REFERENCES "public"."workouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_exercises" ADD CONSTRAINT "workout_exercises_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_exercises" ADD CONSTRAINT "workout_exercises_workout_id_workouts_id_fk" FOREIGN KEY ("workout_id") REFERENCES "public"."workouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_exercises" ADD CONSTRAINT "workout_exercises_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_templates" ADD CONSTRAINT "workout_templates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workouts" ADD CONSTRAINT "workouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workouts" ADD CONSTRAINT "workouts_template_id_workout_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."workout_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workouts" ADD CONSTRAINT "workouts_recommendation_id_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."recommendations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_invocations" ADD CONSTRAINT "ai_invocations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wod_inbox_items" ADD CONSTRAINT "wod_inbox_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wod_inbox_items" ADD CONSTRAINT "wod_inbox_items_workout_id_workouts_id_fk" FOREIGN KEY ("workout_id") REFERENCES "public"."workouts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_zone_set_id_hr_zone_sets_id_fk" FOREIGN KEY ("zone_set_id") REFERENCES "public"."hr_zone_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_raw_payload_id_raw_payloads_id_fk" FOREIGN KEY ("raw_payload_id") REFERENCES "public"."raw_payloads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_workout_id_workouts_id_fk" FOREIGN KEY ("workout_id") REFERENCES "public"."workouts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_laps" ADD CONSTRAINT "activity_laps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_laps" ADD CONSTRAINT "activity_laps_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_streams" ADD CONSTRAINT "activity_streams_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_streams" ADD CONSTRAINT "activity_streams_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_payloads" ADD CONSTRAINT "raw_payloads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "body_compositions" ADD CONSTRAINT "body_compositions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "body_compositions" ADD CONSTRAINT "body_compositions_raw_payload_id_raw_payloads_id_fk" FOREIGN KEY ("raw_payload_id") REFERENCES "public"."raw_payloads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_readiness" ADD CONSTRAINT "daily_readiness_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pain_logs" ADD CONSTRAINT "pain_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_metrics" ADD CONSTRAINT "recovery_metrics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_metrics" ADD CONSTRAINT "recovery_metrics_raw_payload_id_raw_payloads_id_fk" FOREIGN KEY ("raw_payload_id") REFERENCES "public"."raw_payloads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benchmark_results" ADD CONSTRAINT "benchmark_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benchmark_results" ADD CONSTRAINT "benchmark_results_benchmark_id_benchmarks_id_fk" FOREIGN KEY ("benchmark_id") REFERENCES "public"."benchmarks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benchmark_results" ADD CONSTRAINT "benchmark_results_workout_id_workouts_id_fk" FOREIGN KEY ("workout_id") REFERENCES "public"."workouts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benchmarks" ADD CONSTRAINT "benchmarks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_records" ADD CONSTRAINT "personal_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_records" ADD CONSTRAINT "personal_records_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_records" ADD CONSTRAINT "personal_records_benchmark_id_benchmarks_id_fk" FOREIGN KEY ("benchmark_id") REFERENCES "public"."benchmarks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_records" ADD CONSTRAINT "personal_records_workout_id_workouts_id_fk" FOREIGN KEY ("workout_id") REFERENCES "public"."workouts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_records" ADD CONSTRAINT "personal_records_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_workout_id_workouts_id_fk" FOREIGN KEY ("workout_id") REFERENCES "public"."workouts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athlete_model_params" ADD CONSTRAINT "athlete_model_params_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computed_metrics" ADD CONSTRAINT "computed_metrics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_zone_sets" ADD CONSTRAINT "hr_zone_sets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_intents" ADD CONSTRAINT "user_intents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_stimulus_targets" ADD CONSTRAINT "weekly_stimulus_targets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_stimulus_targets" ADD CONSTRAINT "weekly_stimulus_targets_block_id_training_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."training_blocks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_windows" ADD CONSTRAINT "availability_windows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_periods" ADD CONSTRAINT "travel_periods_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_events" ADD CONSTRAINT "client_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_events" ADD CONSTRAINT "client_events_workout_id_workouts_id_fk" FOREIGN KEY ("workout_id") REFERENCES "public"."workouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "athlete_profiles_user_uq" ON "athlete_profiles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "goals_user_active_idx" ON "goals" USING btree ("user_id","active");--> statement-breakpoint
CREATE INDEX "training_blocks_user_starts_idx" ON "training_blocks" USING btree ("user_id","starts_on");--> statement-breakpoint
CREATE UNIQUE INDEX "user_preferences_user_uq" ON "user_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "exercise_aliases_global_alias_uq" ON "exercise_aliases" USING btree ("alias") WHERE "exercise_aliases"."user_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "exercise_aliases_user_alias_uq" ON "exercise_aliases" USING btree ("user_id","alias") WHERE "exercise_aliases"."user_id" is not null;--> statement-breakpoint
CREATE INDEX "exercise_aliases_exercise_idx" ON "exercise_aliases" USING btree ("exercise_id");--> statement-breakpoint
CREATE INDEX "exercises_user_idx" ON "exercises" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cardio_workouts_workout_uq" ON "cardio_workouts" USING btree ("workout_id");--> statement-breakpoint
CREATE UNIQUE INDEX "coach_sessions_workout_uq" ON "coach_sessions" USING btree ("workout_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crossfit_workouts_workout_uq" ON "crossfit_workouts" USING btree ("workout_id");--> statement-breakpoint
CREATE INDEX "strength_sets_user_exercise_completed_idx" ON "strength_sets" USING btree ("user_id","exercise_id","completed_at");--> statement-breakpoint
CREATE INDEX "strength_sets_workout_exercise_idx" ON "strength_sets" USING btree ("workout_exercise_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workout_analyses_workout_phase_uq" ON "workout_analyses" USING btree ("workout_id","phase");--> statement-breakpoint
CREATE INDEX "workout_analyses_user_date_phase_idx" ON "workout_analyses" USING btree ("user_id","date","phase");--> statement-breakpoint
CREATE INDEX "workout_exercises_user_exercise_date_idx" ON "workout_exercises" USING btree ("user_id","exercise_id","date");--> statement-breakpoint
CREATE INDEX "workout_exercises_workout_idx" ON "workout_exercises" USING btree ("workout_id","order");--> statement-breakpoint
CREATE INDEX "workouts_user_date_idx" ON "workouts" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "workouts_user_status_date_idx" ON "workouts" USING btree ("user_id","status","date");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_invocations_cache_uq" ON "ai_invocations" USING btree ("kind","prompt_version","model","input_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "wod_inbox_items_open_hash_uq" ON "wod_inbox_items" USING btree ("user_id","content_hash") WHERE "wod_inbox_items"."status" in ('new', 'parsed', 'needs_review');--> statement-breakpoint
CREATE INDEX "wod_inbox_items_user_status_idx" ON "wod_inbox_items" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "activities_user_provider_external_uq" ON "activities" USING btree ("user_id","provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "activities_user_fingerprint_uq" ON "activities" USING btree ("user_id","fingerprint");--> statement-breakpoint
CREATE INDEX "activities_user_start_idx" ON "activities" USING btree ("user_id","start_at");--> statement-breakpoint
CREATE INDEX "activities_user_local_date_idx" ON "activities" USING btree ("user_id","local_date");--> statement-breakpoint
CREATE INDEX "activities_workout_idx" ON "activities" USING btree ("workout_id");--> statement-breakpoint
CREATE UNIQUE INDEX "activity_laps_activity_lap_uq" ON "activity_laps" USING btree ("activity_id","lap_index");--> statement-breakpoint
CREATE UNIQUE INDEX "activity_streams_activity_stream_uq" ON "activity_streams" USING btree ("activity_id","stream");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_payloads_user_dedupe_uq" ON "raw_payloads" USING btree ("user_id","dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "body_compositions_user_source_external_uq" ON "body_compositions" USING btree ("user_id","source","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "body_compositions_user_manual_measured_uq" ON "body_compositions" USING btree ("user_id","measured_at") WHERE "body_compositions"."source" = 'MANUAL';--> statement-breakpoint
CREATE INDEX "body_compositions_user_local_date_idx" ON "body_compositions" USING btree ("user_id","local_date");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_readiness_user_date_uq" ON "daily_readiness" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "pain_logs_user_status_idx" ON "pain_logs" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_metrics_user_date_metric_source_uq" ON "recovery_metrics" USING btree ("user_id","date","metric","source");--> statement-breakpoint
CREATE INDEX "recovery_metrics_user_metric_date_idx" ON "recovery_metrics" USING btree ("user_id","metric","date");--> statement-breakpoint
CREATE UNIQUE INDEX "benchmark_results_user_benchmark_workout_uq" ON "benchmark_results" USING btree ("user_id","benchmark_id","workout_id");--> statement-breakpoint
CREATE INDEX "benchmark_results_user_benchmark_date_idx" ON "benchmark_results" USING btree ("user_id","benchmark_id","date");--> statement-breakpoint
CREATE INDEX "benchmarks_user_idx" ON "benchmarks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "personal_records_user_kind_exercise_idx" ON "personal_records" USING btree ("user_id","kind","exercise_id");--> statement-breakpoint
CREATE INDEX "test_results_user_key_date_idx" ON "test_results" USING btree ("user_id","test_key","date");--> statement-breakpoint
CREATE UNIQUE INDEX "athlete_model_params_user_key_uq" ON "athlete_model_params" USING btree ("user_id","key");--> statement-breakpoint
CREATE INDEX "computed_metrics_user_metric_scope_date_current_idx" ON "computed_metrics" USING btree ("user_id","metric","scope","date") WHERE "computed_metrics"."superseded" = false;--> statement-breakpoint
CREATE INDEX "hr_zone_sets_user_valid_from_idx" ON "hr_zone_sets" USING btree ("user_id","valid_from");--> statement-breakpoint
CREATE UNIQUE INDEX "recommendations_user_date_version_uq" ON "recommendations" USING btree ("user_id","date","version");--> statement-breakpoint
CREATE UNIQUE INDEX "recommendations_user_date_current_uq" ON "recommendations" USING btree ("user_id","date") WHERE "recommendations"."superseded" = false;--> statement-breakpoint
CREATE INDEX "user_intents_user_starts_status_idx" ON "user_intents" USING btree ("user_id","starts_on","status");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_stimulus_targets_user_week_source_uq" ON "weekly_stimulus_targets" USING btree ("user_id","week_start","source");--> statement-breakpoint
CREATE UNIQUE INDEX "availability_windows_user_source_external_uq" ON "availability_windows" USING btree ("user_id","source","external_id");--> statement-breakpoint
CREATE INDEX "availability_windows_user_date_idx" ON "availability_windows" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "availability_windows_user_weekday_idx" ON "availability_windows" USING btree ("user_id","weekday");--> statement-breakpoint
CREATE INDEX "events_user_date_idx" ON "events" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "travel_periods_user_starts_idx" ON "travel_periods" USING btree ("user_id","starts_on");--> statement-breakpoint
CREATE INDEX "client_events_workout_seq_idx" ON "client_events" USING btree ("workout_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_user_provider_uq" ON "integrations" USING btree ("user_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_jobs_user_kind_dedupe_uq" ON "sync_jobs" USING btree ("user_id","kind","dedupe_key");--> statement-breakpoint
CREATE INDEX "sync_jobs_status_run_after_idx" ON "sync_jobs" USING btree ("status","run_after");