/**
 * Core domain vocabulary shared by every module.
 *
 * Rules:
 *  - Pure TypeScript. No framework, no DB, no SDK imports (enforced by ESLint).
 *  - Every string union has a matching `*_VALUES` const tuple so that Zod schemas and
 *    Postgres enums are generated from one source of truth.
 */

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/** Where a datum comes from. An estimated value must never masquerade as a measured one. */
export const DATA_SOURCE_VALUES = [
  "GARMIN",
  "DEVICE",
  "SCALE",
  "USER",
  "MANUAL",
  "AI_PARSED",
  "HEURISTIC",
  "CALCULATED",
  "ENGINE",
] as const;
export type DataSource = (typeof DATA_SOURCE_VALUES)[number];

export const CONFIDENCE_VALUES = ["HIGH", "MEDIUM", "LOW"] as const;
export type Confidence = (typeof CONFIDENCE_VALUES)[number];

/** Numeric confidence 0..1 → categorical. Thresholds are deliberately simple and documented. */
export function toConfidence(score: number): Confidence {
  if (score >= 0.75) return "HIGH";
  if (score >= 0.45) return "MEDIUM";
  return "LOW";
}

// ---------------------------------------------------------------------------
// Movement taxonomy
// ---------------------------------------------------------------------------

export const MOVEMENT_PATTERN_VALUES = [
  "squat",
  "hinge",
  "horizontal_push",
  "vertical_push",
  "horizontal_pull",
  "vertical_pull",
  "carry",
  "locomotion",
  "rotation_core",
  "olympic_lift",
  "gymnastics",
  "isolation",
] as const;
export type MovementPattern = (typeof MOVEMENT_PATTERN_VALUES)[number];

export const MODALITY_VALUES = [
  "running",
  "bike",
  "row",
  "ski",
  "swimming",
  "walking",
  "strength",
  "gymnastics",
  "weightlifting",
  "mixed_modal",
  "mobility",
  "other",
] as const;
export type Modality = (typeof MODALITY_VALUES)[number];

export const MUSCLE_GROUP_VALUES = [
  "quads",
  "hamstrings",
  "glutes",
  "calves",
  "hip_flexors",
  "adductors",
  "lower_back",
  "core",
  "chest",
  "upper_back",
  "lats",
  "shoulders",
  "traps",
  "biceps",
  "triceps",
  "forearms_grip",
] as const;
export type MuscleGroup = (typeof MUSCLE_GROUP_VALUES)[number];

export const LOWER_BODY_MUSCLES: readonly MuscleGroup[] = [
  "quads",
  "hamstrings",
  "glutes",
  "calves",
  "hip_flexors",
  "adductors",
  "lower_back",
];
export const UPPER_BODY_MUSCLES: readonly MuscleGroup[] = [
  "chest",
  "upper_back",
  "lats",
  "shoulders",
  "traps",
  "biceps",
  "triceps",
  "forearms_grip",
];

export const ENERGY_SYSTEM_VALUES = [
  "aerobic_easy",
  "aerobic_threshold",
  "vo2max",
  "glycolytic",
  "phosphagen",
] as const;
export type EnergySystem = (typeof ENERGY_SYSTEM_VALUES)[number];

export const EQUIPMENT_VALUES = [
  "barbell",
  "dumbbell",
  "kettlebell",
  "machine",
  "cable",
  "pull_up_bar",
  "rings",
  "rower",
  "bike_erg",
  "ski_erg",
  "assault_bike",
  "road_bike",
  "treadmill",
  "track",
  "outdoor",
  "wall_ball",
  "box",
  "jump_rope",
  "sled",
  "sandbag",
  "ghd",
  "bench",
  "rack",
  "bodyweight",
  "pool",
] as const;
export type Equipment = (typeof EQUIPMENT_VALUES)[number];

export const EXERCISE_CATEGORY_VALUES = [
  "barbell",
  "dumbbell",
  "kettlebell",
  "machine",
  "bodyweight",
  "gymnastics",
  "olympic",
  "monostructural",
  "strongman",
  "other",
] as const;
export type ExerciseCategory = (typeof EXERCISE_CATEGORY_VALUES)[number];

export const MEASUREMENT_TYPE_VALUES = [
  "weight_reps",
  "reps",
  "time",
  "distance",
  "calories",
  "height",
] as const;
export type MeasurementType = (typeof MEASUREMENT_TYPE_VALUES)[number];

// ---------------------------------------------------------------------------
// Stimuli (the exposure ledger dimensions) and load dimensions
// ---------------------------------------------------------------------------

export const STIMULUS_KEY_VALUES = [
  "strength_lower",
  "strength_upper",
  "hypertrophy",
  "olympic_technique",
  "gymnastics_skill",
  "aerobic_easy",
  "aerobic_long",
  "threshold",
  "vo2max",
  "power",
  /** Any CrossFit class exposure (skill, strength piece, metcon), whatever its intensity. */
  "crossfit_exposure",
  /** High-intensity conditioning (hard metcons, intervals on ergs) — counts in the hard budget. */
  "hi_conditioning",
  "mobility_recovery",
] as const;
export type StimulusKey = (typeof STIMULUS_KEY_VALUES)[number];

/** 1.0 = one standard exposure of that stimulus. */
export type StimulusCredits = Partial<Record<StimulusKey, number>>;

/** Stimulus keys whose exposure counts as a "hard" session for the weekly hard-session budget. */
export const HARD_STIMULUS_KEYS: readonly StimulusKey[] = ["hi_conditioning", "threshold", "vo2max"];

/**
 * Window over which each stimulus target is counted (days). Low-frequency stimuli are counted over
 * two weeks so that "threshold this week, VO2 next week" is a valid pattern; tests over six weeks.
 */
export const STIMULUS_WINDOW_DAYS: Record<StimulusKey, number> = {
  strength_lower: 7,
  strength_upper: 7,
  hypertrophy: 7,
  olympic_technique: 7,
  gymnastics_skill: 7,
  aerobic_easy: 7,
  aerobic_long: 7,
  threshold: 14,
  vo2max: 14,
  power: 14,
  crossfit_exposure: 7,
  hi_conditioning: 7,
  mobility_recovery: 7,
};

export const LOAD_DIMENSION_VALUES = [
  "cardiovascular",
  "muscular_lower",
  "muscular_upper",
  "impact",
  "eccentric",
  "technical",
] as const;
export type LoadDimension = (typeof LOAD_DIMENSION_VALUES)[number];

/** Each dimension is 0..10 for a single session (10 = maximal single-session load in that dimension). */
export type LoadVector = Record<LoadDimension, number>;

export function emptyLoadVector(): LoadVector {
  return {
    cardiovascular: 0,
    muscular_lower: 0,
    muscular_upper: 0,
    impact: 0,
    eccentric: 0,
    technical: 0,
  };
}

export function addLoadVectors(a: LoadVector, b: LoadVector): LoadVector {
  const out = emptyLoadVector();
  for (const k of LOAD_DIMENSION_VALUES) out[k] = a[k] + b[k];
  return out;
}

export function clampLoadVector(v: LoadVector, max = 10): LoadVector {
  const out = emptyLoadVector();
  for (const k of LOAD_DIMENSION_VALUES) out[k] = Math.max(0, Math.min(max, v[k]));
  return out;
}

export type PatternExposure = Partial<Record<MovementPattern, number>>;
export type MuscleExposure = Partial<Record<MuscleGroup, number>>;

export function mergeExposure<K extends string>(
  a: Partial<Record<K, number>>,
  b: Partial<Record<K, number>>,
): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = { ...a };
  for (const key of Object.keys(b) as K[]) {
    out[key] = (out[key] ?? 0) + (b[key] ?? 0);
  }
  return out;
}

export function mergeCredits(a: StimulusCredits, b: StimulusCredits): StimulusCredits {
  return mergeExposure<StimulusKey>(a, b);
}

// ---------------------------------------------------------------------------
// Sessions / workouts
// ---------------------------------------------------------------------------

export const INTENSITY_BAND_VALUES = ["easy", "moderate", "hard"] as const;
export type IntensityBand = (typeof INTENSITY_BAND_VALUES)[number];

export const WORKOUT_TYPE_VALUES = [
  "strength",
  "cardio",
  "crossfit",
  "coach_session",
  "mobility",
  "free",
  "rest",
] as const;
export type WorkoutType = (typeof WORKOUT_TYPE_VALUES)[number];

export const WORKOUT_STATUS_VALUES = [
  "planned",
  "in_progress",
  "done",
  "skipped",
  "auto_adjusted",
] as const;
export type WorkoutStatus = (typeof WORKOUT_STATUS_VALUES)[number];

export const WORKOUT_SOURCE_VALUES = [
  "planned_engine",
  "planned_user",
  "manual",
  "garmin",
  "fit_import",
  "wod_inbox",
] as const;
export type WorkoutSource = (typeof WORKOUT_SOURCE_VALUES)[number];

export const FEELING_VALUES = ["great", "good", "meh", "too_hard"] as const;
export type Feeling = (typeof FEELING_VALUES)[number];

/** Feeling → fun score on a 1..10 scale (documented mapping, spec §22). */
export const FEELING_TO_FUN: Record<Feeling, number> = {
  great: 9,
  good: 7,
  meh: 4,
  too_hard: 3,
};

export const CARDIO_KIND_VALUES = [
  "zone2",
  "long",
  "recovery",
  "tempo",
  "threshold",
  "vo2max",
  "intervals",
  "fartlek",
  "hills",
  "strides",
  "test",
  "free",
] as const;
export type CardioKind = (typeof CARDIO_KIND_VALUES)[number];

/**
 * Canonical session kinds used by the engine's candidate catalog, templates and UI labels.
 * Kept as a string union so the catalog can grow without schema migrations.
 */
export const SESSION_KIND_VALUES = [
  "crossfit_as_programmed",
  "crossfit_generic",
  "partner_wod_fun",
  "benchmark_attempt",
  "strength_lower",
  "strength_upper",
  "strength_full",
  "accessory_upper",
  "olympic_technique",
  "gymnastics_skill",
  "run_easy_45",
  "run_easy_60",
  "run_long_90",
  "run_tempo",
  "run_threshold",
  "run_vo2",
  "strides",
  "bike_easy_60",
  "bike_long_120",
  "bike_intervals",
  "row_easy_30",
  "row_intervals",
  "ski_easy_30",
  "walk_45",
  "mobility_20",
  "recovery_spin_30",
  "test_run_5k",
  "test_row_2k",
  "rest",
] as const;
export type SessionKind = (typeof SESSION_KIND_VALUES)[number];

// ---------------------------------------------------------------------------
// Goals, blocks, intents
// ---------------------------------------------------------------------------

export const GOAL_KEY_VALUES = [
  "health_longevity",
  "crossfit",
  "endurance",
  "strength",
  "physique",
  "fun",
  "event_5k",
  "event_10k",
  "event_hyrox",
  "event_open",
  "event_trail",
  "skill_muscle_up",
  "skill_handstand_walk",
  "lift_clean",
  "lift_snatch",
  "zone2_capacity",
] as const;
export type GoalKey = (typeof GOAL_KEY_VALUES)[number];

export type GoalWeights = Partial<Record<GoalKey, number>>;

export const BLOCK_FOCUS_VALUES = ["base", "build", "performance", "recovery", "custom"] as const;
export type BlockFocus = (typeof BLOCK_FOCUS_VALUES)[number];

export const INTENT_KIND_VALUES = [
  "want_run",
  "want_bike",
  "want_row",
  "want_crossfit",
  "want_strength",
  "want_big_session",
  "no_strength",
  "no_legs",
  "going_crossfit",
  "just_move",
  "rest",
  "feel_hot",
  "lazy",
  "have_time",
  "surprise",
  "custom",
] as const;
export type IntentKind = (typeof INTENT_KIND_VALUES)[number];

export interface UserIntent {
  kind: IntentKind;
  /** Desired intensity if the user said so ("un gros Hyrox", "juste bouger"). */
  intensity?: IntensityBand;
  /** Minutes available if declared ("j'ai 90 minutes"). */
  availableMinutes?: number;
  /** Free text kept for explanation/debug (never sent back to the AI with other data). */
  rawText?: string;
  /** Date the intent applies to (YYYY-MM-DD). Defaults to today. */
  date?: string;
}

// ---------------------------------------------------------------------------
// Pain
// ---------------------------------------------------------------------------

export const PAIN_LOCATION_VALUES = [
  "neck",
  "shoulder",
  "elbow",
  "wrist",
  "upper_back",
  "lower_back",
  "hip",
  "groin",
  "knee",
  "shin",
  "calf",
  "achilles",
  "ankle",
  "foot",
  "hamstring",
  "quad",
  "other",
] as const;
export type PainLocation = (typeof PAIN_LOCATION_VALUES)[number];

export interface ActivePain {
  location: PainLocation;
  side?: "left" | "right" | "both";
  /** 0..10 */
  intensity: number;
  movementSpecific: boolean;
  /** Exercise ids or movement patterns that provoke it. */
  movements: string[];
  sudden: boolean;
  persistent: boolean;
  reportedAt: string;
}

// ---------------------------------------------------------------------------
// Time windows
// ---------------------------------------------------------------------------

export interface TimeWindow {
  /** Minutes since midnight, athlete-local. */
  startMinute: number;
  endMinute: number;
}

export function windowMinutes(w: TimeWindow): number {
  return Math.max(0, w.endMinute - w.startMinute);
}
