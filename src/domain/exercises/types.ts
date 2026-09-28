import type {
  Equipment,
  ExerciseCategory,
  MeasurementType,
  Modality,
  MovementPattern,
  MuscleGroup,
} from "../core";

/**
 * Relative per-unit cost of an exercise, used by the WOD analyzer and strength templates to
 * estimate load vectors. Scale 0..3 per dimension for "one moderate rep / one unit of work".
 *  - lower / upper: muscular cost
 *  - cardio: metabolic cost when performed at metcon pace
 */
export interface ExerciseCost {
  lower: number;
  upper: number;
  cardio: number;
}

export interface ExerciseDef {
  /** Stable slug id, e.g. `back_squat`. */
  id: string;
  name: string;
  /** Lowercase aliases, including French, abbreviations and common misspellings. */
  aliases: readonly string[];
  category: ExerciseCategory;
  movementPattern: MovementPattern;
  secondaryPatterns?: readonly MovementPattern[];
  primaryMuscles: readonly MuscleGroup[];
  secondaryMuscles?: readonly MuscleGroup[];
  equipment: readonly Equipment[];
  measurementType: MeasurementType;
  /** Default load step when the user has not configured one (kg). */
  defaultIncrementKg?: number;
  /** 1 = trivial … 5 = highly technical (Olympic lifts, ring muscle-ups). */
  technicalDifficulty: 1 | 2 | 3 | 4 | 5;
  /** 0 = none … 3 = high (running, box jumps, double-unders). */
  impactLevel: 0 | 1 | 2 | 3;
  /** 0 = none … 3 = high (Romanian deadlift, downhill running, GHD). */
  eccentricLoad: 0 | 1 | 2 | 3;
  /** Monostructural modality when applicable. */
  modality?: Modality;
  /** Tracked as a PR lift by default (spec §18). */
  isBenchmarkLift?: boolean;
  cost: ExerciseCost;
}

export interface ResolvedExercise {
  exercise: ExerciseDef;
  /** 0..1 — 1 for exact alias match. */
  confidence: number;
  /** How the match was found; useful for debugging parser output. */
  method: "exact" | "singular" | "fuzzy";
}
