import type { MovementPattern, MuscleGroup } from "@/domain/core";

/** French UI labels for the Progress dashboards. Pure data (client- and server-importable). */

export const RANGE_LABEL_FR: Record<string, string> = {
  "7d": "7 j",
  "4w": "4 sem",
  "3m": "3 mois",
  "6m": "6 mois",
  "1y": "1 an",
  all: "Tout",
};

export const PATTERN_LABEL_FR: Record<MovementPattern, string> = {
  squat: "Squat",
  hinge: "Hinge",
  horizontal_push: "Poussée horizontale",
  vertical_push: "Poussée verticale",
  horizontal_pull: "Tirage horizontal",
  vertical_pull: "Tirage vertical",
  carry: "Port de charge",
  locomotion: "Locomotion",
  rotation_core: "Rotation / gainage",
  olympic_lift: "Haltéro",
  gymnastics: "Gymnastique",
  isolation: "Isolation",
};

export const MUSCLE_LABEL_FR: Record<MuscleGroup, string> = {
  quads: "Quadriceps",
  hamstrings: "Ischios",
  glutes: "Fessiers",
  calves: "Mollets",
  hip_flexors: "Fléchisseurs de hanche",
  adductors: "Adducteurs",
  lower_back: "Lombaires",
  core: "Gainage",
  chest: "Pectoraux",
  upper_back: "Haut du dos",
  lats: "Dorsaux",
  shoulders: "Épaules",
  traps: "Trapèzes",
  biceps: "Biceps",
  triceps: "Triceps",
  forearms_grip: "Avant-bras / grip",
};

export const TEST_KEY_LABEL_FR: Record<string, string> = {
  run_5k: "5 km course",
  test_run_5k: "5 km course",
  run_10k: "10 km course",
  test_run_10k: "10 km course",
  row_2k: "2 km rameur",
  test_row_2k: "2 km rameur",
  row_5k: "5 km rameur",
  cooper: "Cooper",
  lthr: "FC seuil",
};

export const PR_KIND_LABEL_FR: Record<string, string> = {
  weight: "charge",
  reps: "reps",
  e1rm: "e1RM",
  time: "temps",
  distance: "distance",
  pace: "allure",
  benchmark: "benchmark",
  calories: "calories",
};
