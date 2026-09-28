import type { IntensityBand, LoadVector, SessionKind, StimulusCredits } from "../core";
import type { StrengthPrescription } from "./types";

export interface TemplateExercise {
  exerciseId: string;
  prescription: StrengthPrescription;
  /** Optional alternates the UI may swap in (equipment/pain). */
  alternates?: string[];
}

export interface StrengthTemplate {
  id: string;
  kind: SessionKind;
  name: string;
  durationMin: number;
  intensity: IntensityBand;
  exercises: TemplateExercise[];
  expectedCredits: StimulusCredits;
  loadVector: LoadVector;
}

const p = (
  sets: number,
  repMin: number,
  repMax: number,
  intent: StrengthPrescription["intent"],
  targetRpeMin = 7,
  targetRpeMax = 8.5,
): StrengthPrescription => ({
  sets,
  repMin,
  repMax,
  intent,
  targetRpeMin,
  targetRpeMax,
  loadSuggestionKg: null,
  restSec: null,
});

/**
 * Starting templates (v1). The engine picks the kind; the strength service instantiates the
 * template, then the progression engine fills `loadSuggestionKg` per exercise from history.
 */
export const STRENGTH_TEMPLATES: readonly StrengthTemplate[] = [
  {
    id: "lower_a",
    kind: "strength_lower",
    name: "Strength — Lower",
    durationMin: 60,
    intensity: "hard",
    exercises: [
      {
        exerciseId: "back_squat",
        prescription: p(4, 4, 6, "strength"),
        alternates: ["front_squat", "leg_press"],
      },
      {
        exerciseId: "romanian_deadlift",
        prescription: p(3, 6, 8, "hypertrophy"),
        alternates: ["good_morning", "leg_curl"],
      },
      {
        exerciseId: "lunge",
        prescription: p(3, 8, 10, "hypertrophy", 7, 8),
        alternates: ["box_step_up"],
      },
      { exerciseId: "hip_thrust", prescription: p(3, 8, 12, "hypertrophy", 7, 8.5) },
    ],
    expectedCredits: { strength_lower: 1, hypertrophy: 0.5 },
    loadVector: {
      cardiovascular: 2,
      muscular_lower: 8,
      muscular_upper: 1,
      impact: 0,
      eccentric: 6,
      technical: 3,
    },
  },
  {
    id: "upper_a",
    kind: "strength_upper",
    name: "Strength — Upper",
    durationMin: 60,
    intensity: "moderate",
    exercises: [
      {
        exerciseId: "bench_press",
        prescription: p(4, 4, 6, "strength"),
        alternates: ["dumbbell_bench_press"],
      },
      {
        exerciseId: "strict_pull_up",
        prescription: p(4, 4, 8, "strength", 7, 8.5),
        alternates: ["lat_pulldown", "ring_row"],
      },
      {
        exerciseId: "strict_press",
        prescription: p(3, 5, 8, "strength"),
        alternates: ["dumbbell_press"],
      },
      {
        exerciseId: "dumbbell_row",
        prescription: p(3, 8, 12, "hypertrophy", 7, 8.5),
        alternates: ["cable_row", "barbell_row"],
      },
      { exerciseId: "face_pull", prescription: p(2, 12, 15, "hypertrophy", 7, 8) },
    ],
    expectedCredits: { strength_upper: 1, hypertrophy: 0.5 },
    loadVector: {
      cardiovascular: 2,
      muscular_lower: 0.5,
      muscular_upper: 8,
      impact: 0,
      eccentric: 4,
      technical: 2,
    },
  },
  {
    id: "full_a",
    kind: "strength_full",
    name: "Strength — Full body",
    durationMin: 60,
    intensity: "moderate",
    exercises: [
      {
        exerciseId: "front_squat",
        prescription: p(3, 4, 6, "strength"),
        alternates: ["goblet_squat"],
      },
      { exerciseId: "bench_press", prescription: p(3, 5, 8, "strength"), alternates: ["push_up"] },
      {
        exerciseId: "deadlift",
        prescription: p(2, 3, 5, "strength", 7, 8),
        alternates: ["romanian_deadlift"],
      },
      {
        exerciseId: "pull_up",
        prescription: p(3, 6, 10, "hypertrophy", 7, 8.5),
        alternates: ["ring_row"],
      },
    ],
    expectedCredits: { strength_lower: 0.7, strength_upper: 0.7 },
    loadVector: {
      cardiovascular: 2,
      muscular_lower: 6,
      muscular_upper: 6,
      impact: 0,
      eccentric: 5,
      technical: 3,
    },
  },
  {
    id: "accessory_upper_a",
    kind: "accessory_upper",
    name: "Accessoires haut du corps",
    durationMin: 40,
    intensity: "easy",
    exercises: [
      { exerciseId: "dumbbell_row", prescription: p(3, 10, 12, "hypertrophy", 7, 8) },
      { exerciseId: "dumbbell_press", prescription: p(3, 10, 12, "hypertrophy", 7, 8) },
      { exerciseId: "face_pull", prescription: p(3, 12, 15, "hypertrophy", 6, 8) },
      { exerciseId: "biceps_curl", prescription: p(2, 10, 15, "hypertrophy", 7, 8) },
      { exerciseId: "triceps_extension", prescription: p(2, 10, 15, "hypertrophy", 7, 8) },
    ],
    expectedCredits: { hypertrophy: 0.7, strength_upper: 0.3 },
    loadVector: {
      cardiovascular: 1,
      muscular_lower: 0,
      muscular_upper: 5,
      impact: 0,
      eccentric: 3,
      technical: 1,
    },
  },
  {
    id: "olympic_technique_a",
    kind: "olympic_technique",
    name: "Technique haltéro",
    durationMin: 45,
    intensity: "moderate",
    exercises: [
      { exerciseId: "snatch", prescription: p(6, 2, 3, "skill", 6, 7.5) },
      { exerciseId: "clean_and_jerk", prescription: p(5, 1, 2, "skill", 6, 7.5) },
      { exerciseId: "snatch_pull", prescription: p(3, 3, 3, "power", 7, 8) },
    ],
    expectedCredits: { olympic_technique: 1, power: 0.5 },
    loadVector: {
      cardiovascular: 2,
      muscular_lower: 4,
      muscular_upper: 3,
      impact: 1,
      eccentric: 2,
      technical: 8,
    },
  },
  {
    id: "gymnastics_skill_a",
    kind: "gymnastics_skill",
    name: "Skill gymnastique",
    durationMin: 40,
    intensity: "easy",
    exercises: [
      { exerciseId: "strict_pull_up", prescription: p(5, 3, 5, "skill", 6, 7.5) },
      {
        exerciseId: "strict_handstand_push_up",
        prescription: p(5, 2, 4, "skill", 6, 7.5),
        alternates: ["handstand_push_up", "dumbbell_press"],
      },
      { exerciseId: "toes_to_bar", prescription: p(4, 5, 8, "skill", 6, 7.5) },
      { exerciseId: "hollow_rock", prescription: p(3, 15, 20, "circuit", 6, 7) },
    ],
    expectedCredits: { gymnastics_skill: 1 },
    loadVector: {
      cardiovascular: 2,
      muscular_lower: 0.5,
      muscular_upper: 4,
      impact: 0,
      eccentric: 2,
      technical: 6,
    },
  },
];

export function getStrengthTemplate(id: string): StrengthTemplate | undefined {
  return STRENGTH_TEMPLATES.find((t) => t.id === id);
}

export function templatesForKind(kind: SessionKind): StrengthTemplate[] {
  return STRENGTH_TEMPLATES.filter((t) => t.kind === kind);
}
