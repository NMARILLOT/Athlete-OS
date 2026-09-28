# Athlete OS — Data model

Postgres via Drizzle. Conventions: `snake_case` tables/columns, `uuid` primary keys (`gen_random_uuid()`), `timestamptz`
everywhere, `date` for calendar days (athlete-local), JSONB columns validated by Zod at the boundary, every user-owned
table has `user_id` + `created_at` + `updated_at`. Enums are Postgres enums generated from the domain string unions in
`src/domain/core`.

## 1. Identity & profile

| Table               | Purpose / notable columns                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `users`             | `id` (= Supabase auth uid or local fixed uuid), `email`, `display_name`, `timezone`, `onboarding_completed_at`             |
| `athlete_profiles`  | 1:1 user. `birth_date?`, `height_cm?`, `sex?`, `resting_hr_manual?`, `max_hr_manual?`, `lthr_manual?`, `baseline_phase_until` (date), `weekly_hours_target` (numeric), `preferred_training_times` JSONB |
| `user_preferences`  | 1:1 user. `units` (metric), `barbell_increment_kg` (2.5), `dumbbell_increment_kg` (2), `machine_increment_kg`, `rest_timer_defaults` JSONB, `notification_settings` JSONB, `composite_score_enabled` (bool, default false), `favourite_modalities` text[], `disliked_modalities` text[] |
| `goals`             | `horizon` (`long|medium|short`), `key` (e.g. `health_longevity`, `crossfit`, `endurance`, `strength`, `physique`, `fun`, `event_5k`, `skill_muscle_up`), `title`, `weight` (0–1), `target` JSONB, `active`, `starts_on?`, `ends_on?` |
| `training_blocks`   | `name`, `focus` (`base|build|performance|recovery|custom`), `starts_on`, `ends_on?`, `stimulus_targets` JSONB (`Record<StimulusKey, number>` override), `notes` |

## 2. Exercise catalog

| Table              | Columns                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `exercises`        | `id` (slug PK, e.g. `back_squat`), `name`, `category` (`barbell|dumbbell|kettlebell|machine|bodyweight|gymnastics|olympic|monostructural|other`), `movement_pattern`, `secondary_patterns` text[], `primary_muscles` text[], `secondary_muscles` text[], `equipment` text[], `measurement_type` (`weight_reps|reps|time|distance|calories|height`), `default_increment_kg?`, `technical_difficulty` (1–5), `impact_level` (0–3), `eccentric_load` (0–3), `is_benchmark_lift` bool, `user_id?` (null = global catalog) |
| `exercise_aliases` | `alias` (lowercased, unique per exercise), `exercise_id`. Seeded from the domain catalog; user can add.                                     |

The canonical catalog lives in code (`src/domain/exercises/catalog.ts`) and is **seeded** into these tables so the DB can
join on it and users can extend it. The domain resolver works from the in-memory catalog (fast path for WOD parsing).

## 3. Unified workouts

| Table                | Columns                                                                                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workouts`           | **Single calendar truth.** `type` (`strength|cardio|crossfit|coach_session|mobility|free|rest`), `source` (`planned_engine|planned_user|manual|garmin|fit_import|wod_inbox`), `status` (`planned|in_progress|done|skipped|auto_adjusted`), `date`, `start_time?`, `planned_duration_min?`, `actual_duration_min?`, `title`, `intensity` (`easy|moderate|hard`), `rpe?` (1–10), `fun_score?` (1–4 emoji → 1..4 and/or 1–10), `feeling?` (`great|good|meh|too_hard`), `pain_reported` bool, `notes`, `template_id?`, `recommendation_id?`, `activity_id?` (linked Garmin/FIT activity), `session_rpe_load?` (calculated), `fixed` bool (e.g. CrossFit class at 18:30, coaching) |
| `workout_exercises`  | Strength/free content: `workout_id`, `order`, `exercise_id`, `prescription` JSONB (`{ sets, repMin, repMax, targetRpe, loadSuggestionKg, restSec, notes }`), `superset_group?`                   |
| `strength_sets`      | `id` (client-generated uuid for offline idempotency), `workout_exercise_id`, `set_index`, `reps`, `weight_kg`, `rpe?`, `rir?`, `is_warmup`, `completed_at`, `quality` (`easy|perfect|hard|failed`), `e1rm_kg?` (calculated, `e1rm_epley_v1`) |
| `cardio_workouts`    | 1:1 with cardio workout: `modality`, `workout_kind` (`zone2|long|recovery|tempo|threshold|vo2max|intervals|fartlek|hills|strides|test|free`), `steps` JSONB (`CardioStep[]`), `zone_set_id?`, `garmin_workout_id?`, `garmin_sync_status` (`not_sent|pending|synced|failed`), `garmin_scheduled_for?` |
| `crossfit_workouts`  | 1:1 with crossfit workout: `wod_inbox_item_id?`, `normalized_wod` JSONB (`NormalizedWod`), `score` JSONB (`{ kind: time|rounds_reps|reps|load, value, rx: bool, scaled_notes }`), `benchmark_id?`, `time_domain` |
| `coach_sessions`     | 1:1 with coach_session workout: `demo_level` (`none|light|moderate|heavy`), `standing_minutes`, `perceived_fatigue?` (1–5)                                                                       |
| `workout_templates`  | Reusable strength/cardio/free templates: `kind`, `name`, `body` JSONB (exercise prescriptions or cardio steps), `expected_credits` JSONB, `expected_load` JSONB, `default_duration_min`, `intensity`, `user_id?` |
| `workout_stimuli`    | Ledger credits: `workout_id`, `stimulus_key`, `credit` (numeric), `source` (`CALCULATED|AI_PARSED|USER`), `algorithm_version`. Also `pattern_exposure` JSONB, `muscle_exposure` JSONB, `load_vector` JSONB on the parent row group (stored in `workout_analyses` below) |
| `workout_analyses`   | 1:1 per workout: `load_vector` JSONB, `pattern_exposure` JSONB, `muscle_exposure` JSONB, `stimulus_credits` JSONB, `energy_systems` JSONB, `impact_load`, `algorithm_version`, `confidence`, `computed_at` |

`workout_stimuli` is a query-friendly denormalisation of `workout_analyses.stimulus_credits` (indexed by `user_id, date, stimulus_key`).

## 4. WOD Inbox & AI

| Table              | Columns                                                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wod_inbox_items`  | `input_kind` (`paste|quick|photo|connector`), `raw_text?`, `image_path?`, `status` (`new|parsed|needs_review|confirmed|discarded`), `normalized_wod` JSONB?, `parse_source` (`AI_PARSED|HEURISTIC|USER`), `parse_confidence`, `scheduled_for?` (date), `workout_id?` |
| `wod_analyses`     | `wod_inbox_item_id`, `analysis` JSONB (`WodAnalysis`), `algorithm_version`, `confidence`                                                                             |
| `ai_invocations`   | `kind` (`parse_wod|parse_intent|explain|suggest_fun|monthly_review`), `model`, `prompt_version`, `input_hash`, `output` JSONB (validated), `valid` bool, `error?`, `latency_ms`, `tokens_in/out` |

## 5. Activities (Garmin / FIT)

| Table                | Columns                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `activities`         | `provider` (`garmin|fit_import|manual`), `external_id?` (unique with provider), `sport`, `sub_sport?`, `start_time`, `duration_sec`, `distance_m?`, `avg_hr?`, `max_hr?`, `avg_pace_sec_km?`, `avg_power_w?`, `avg_cadence?`, `elevation_gain_m?`, `calories?`, `avg_stride_length_m?`, `avg_gct_ms?`, `avg_vertical_oscillation_mm?`, `avg_vertical_ratio?`, `gct_balance?`, `temperature_c?`, `training_effect` JSONB?, `zone_set_id?`, `time_in_zones` JSONB?, `raw_payload_id`, `parser_version`, `workout_id?`, `comparable_group?` |
| `activity_laps`      | `activity_id`, `lap_index`, `start_time`, `duration_sec`, `distance_m?`, `avg_hr?`, `max_hr?`, `avg_pace_sec_km?`, `avg_power_w?`, `avg_cadence?`, `elevation_gain_m?` |
| `activity_streams`   | `activity_id`, `stream` (`hr|pace|speed|power|cadence|altitude|distance|gct|vo|stride`), `sample_interval_sec`, `values` JSONB (number[] — nulls allowed), `count` |
| `raw_payloads`       | `provider`, `kind` (`activity_summary|activity_details|fit_file|health_daily|sleep|body_comp`), `external_id?`, `payload` JSONB?, `storage_path?`, `parser_version?`, `imported_at`, `dedupe_key` (unique per user) |

## 6. Recovery, readiness, body, pain

| Table               | Columns                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `daily_readiness`   | unique `(user_id, date)`. Declared: `energy` (1–3), `soreness` (0–3), `motivation` (1–3), `unusual_pain` bool, `note`. Measured snapshot copied for the day: `sleep_hours?`, `sleep_score?`, `resting_hr?`, `hrv_ms?`, `stress?`, `body_battery?` with `metrics_source`. `summary` JSONB (engine's readiness summary, versioned) |
| `recovery_metrics`  | time series, unique `(user_id, date, metric, source)`: `metric` (`sleep_hours|sleep_score|resting_hr|hrv_rmssd|stress|body_battery|respiration|vo2max_est|lthr|...`), `value`, `unit`, `source`, `confidence` |
| `body_compositions` | `measured_at`, `weight_kg`, `body_fat_pct?`, `muscle_mass_kg?`, `water_pct?`, `bone_mass_kg?`, `extra` JSONB, `source` (`SCALE|GARMIN|MANUAL`), `provider?`, `external_id?`                 |
| `pain_logs`         | `reported_at`, `location`, `side?`, `intensity` (0–10), `movement_specific` bool, `movements` text[], `sudden` bool, `persistent` bool, `status` (`active|improving|resolved`), `resolved_at?`, `notes` |

## 7. Records, benchmarks, tests

| Table                | Columns                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `personal_records`   | `kind` (`weight|reps|e1rm|time|distance|pace|benchmark|calories`), `exercise_id?`, `benchmark_id?`, `distance_key?` (`5k|10k|2k_row|...`), `value`, `unit`, `reps?`, `achieved_at`, `workout_id?`, `activity_id?`, `source`, `estimated` bool, `previous_value?` |
| `benchmarks`         | `id` (slug), `name`, `kind` (`girl|hero|open|custom`), `description`, `score_kind`, `normalized_wod` JSONB?, `user_id?`                                        |
| `benchmark_results`  | `benchmark_id`, `workout_id?`, `date`, `score_value`, `score_kind`, `rx` bool, `notes`                                                                          |
| `test_results`       | `test_key` (`run_5k|run_10k|cooper|row_2k|row_5k|bike_erg_20min|ski_2k|squat_3rm|custom`), `date`, `value`, `unit`, `conditions` JSONB (temp, terrain, fatigue, notes), `activity_id?`, `workout_id?` |

## 8. Stimulus targets & engine

| Table                     | Columns                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `weekly_stimulus_targets` | `week_start` (Monday date), `targets` JSONB (`Record<StimulusKey, number>`), `source` (`ENGINE|USER`), `block_id?`                                                       |
| `recommendations`         | unique `(user_id, date, version)`: `engine_version`, `inputs_snapshot` JSONB, `output` JSONB (`Recommendation`), `rules_triggered` text[], `explanation`, `confidence` (`HIGH|MEDIUM|LOW`), `accepted_option?` (`primary|alternative:n|custom|rest`), `superseded` bool, `computed_at` |
| `user_intents`            | Declared wishes: `date`, `kind` (`want_run|want_crossfit|want_bike_week|want_big_session|no_strength|going_crossfit|just_move|rest|feel_hot|lazy|have_time|surprise|custom`), `params` JSONB, `raw_text?`, `parsed_by` (`USER|AI_PARSED`), `applied` bool |
| `computed_metrics`        | `metric` (`pace_at_hr|aerobic_decoupling|efficiency_factor|threshold_pace|threshold_hr|weekly_load|acute_load_7d|chronic_load_28d|rhr_baseline_28d|hrv_baseline_28d|...`), `scope` (`activity|workout|day|week|exercise`), `scope_id?`, `date`, `value`, `unit`, `algorithm_version`, `inputs` JSONB, `computed_at`, `superseded` bool |
| `hr_zone_sets`            | `valid_from`, `method` (`lthr|test|hrr|garmin|manual`), `lthr?`, `max_hr?`, `resting_hr?`, `zones` JSONB (`[{zone, minBpm, maxBpm}]`), `source`, `confidence`. Immutable; latest by `valid_from` is current. |
| `athlete_model_params`    | Learned parameters: `key` (`fatigue_half_life.muscular_lower`, `exercise_cost.wall_ball`, …), `value` numeric, `confidence`, `evidence_count`, `updated_at`. Defaults live in code. |

## 9. Calendar, availability, events

| Table                  | Columns                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `availability_windows` | Recurring or dated: `weekday?` (0–6), `date?`, `start_minute`, `end_minute`, `kind` (`available|busy`), `source` (`USER|CALENDAR_PROVIDER`), `label?` (never the private event title when imported) |
| `events`               | `kind` (`crossfit_competition|hyrox|running_race|trail|cycling|benchmark_day|other`), `name`, `date`, `priority` (`A|B|C`), `taper_days`, `notes` |
| `travel_periods`       | `destination`, `starts_on`, `ends_on`, `equipment` text[], `crossfit_access` bool, `gym_access` bool, `running_ok` bool, `bike_ok` bool, `notes` |

## 10. Integrations & jobs

| Table          | Columns                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integrations` | unique `(user_id, provider)`: `provider` (`garmin|withings|google_calendar|...`), `status` (`disconnected|connected|error`), `credentials_encrypted` bytea?, `external_user_id?`, `scopes` text[], `connected_at?`, `last_sync_at?`, `last_error?` |
| `sync_jobs`    | `kind` (`garmin_activities|garmin_health|fit_import|bodycomp|recompute_recommendation|weekly_review`), `dedupe_key` (unique with user & kind), `status` (`queued|running|done|failed`), `attempts`, `payload` JSONB, `result` JSONB?, `error?`, `run_after`, `started_at?`, `finished_at?` |

## 11. Indices that matter

- `workouts (user_id, date)`; `workouts (user_id, status, date)`
- `workout_stimuli (user_id, date, stimulus_key)`
- `strength_sets (workout_exercise_id, set_index)`; `strength_sets (user_id, exercise_id, completed_at)` (denormalised `user_id`, `exercise_id` for exercise pages)
- `activities (user_id, start_time)`; unique `(provider, external_id)`
- `recovery_metrics (user_id, metric, date)`
- `computed_metrics (user_id, metric, scope, date)` where `superseded = false`
- `recommendations (user_id, date)` where `superseded = false`

## 12. JSONB contracts (Zod, in `src/domain`)

- `NormalizedWod`, `WodAnalysis` — `domain/wod/schema.ts`
- `CardioStep[]` — `domain/cardio/builder.ts`
- `Recommendation`, `EngineInputSnapshot` — `domain/engine/types.ts`
- `StrengthPrescription` — `domain/strength/types.ts`
- `ReadinessSummary` — `domain/readiness/types.ts`
- `HrZoneSet` — `domain/cardio/zones.ts`

Every JSONB write goes through `schema.parse()`; every read goes through `schema.safeParse()` with a logged fallback.
