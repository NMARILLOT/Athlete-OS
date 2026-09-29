import type { BlockFocus, Equipment, Modality, PainLocation } from "@/domain/core";

/**
 * French UI labels for the profile & onboarding screens. Pure data (importable from client and
 * server components alike); DB titles for goals live in profile.service.ts.
 */

export const MODALITY_LABEL_FR: Record<Modality, string> = {
  running: "Course",
  bike: "Vélo",
  row: "Rameur",
  ski: "Ski erg",
  swimming: "Natation",
  walking: "Marche",
  strength: "Musculation",
  gymnastics: "Gymnastique",
  weightlifting: "Haltérophilie",
  mixed_modal: "CrossFit / mixte",
  mobility: "Mobilité",
  other: "Autre",
};

export const EQUIPMENT_LABEL_FR: Record<Equipment, string> = {
  barbell: "Barre",
  dumbbell: "Haltères",
  kettlebell: "Kettlebell",
  machine: "Machines",
  cable: "Poulie",
  pull_up_bar: "Barre de traction",
  rings: "Anneaux",
  rower: "Rameur",
  bike_erg: "Bike erg",
  ski_erg: "Ski erg",
  assault_bike: "Assault bike",
  road_bike: "Vélo de route",
  treadmill: "Tapis",
  track: "Piste",
  outdoor: "Extérieur",
  wall_ball: "Wall ball",
  box: "Box (plyo)",
  jump_rope: "Corde à sauter",
  sled: "Traîneau",
  sandbag: "Sandbag",
  ghd: "GHD",
  bench: "Banc",
  rack: "Rack",
  bodyweight: "Poids du corps",
  pool: "Piscine",
};

export type FacilityKey = "crossfitBox" | "gym" | "home";
export const FACILITY_LABEL_FR: Record<FacilityKey, string> = {
  crossfitBox: "Box CrossFit",
  gym: "Salle",
  home: "Maison",
};

export const BLOCK_FOCUS_LABEL_FR: Record<BlockFocus, string> = {
  base: "Base aérobie + force",
  build: "Construction",
  performance: "Performance",
  recovery: "Deload",
  custom: "Libre",
};

export const BLOCK_FOCUS_HINT_FR: Record<Exclude<BlockFocus, "recovery">, string> = {
  base: "Volume facile, force régulière, peu de séances dures.",
  build: "Seuil, VO2 et force lourde montent progressivement.",
  performance: "Priorité aux séances spécifiques et aux benchmarks.",
  custom: "Aucune dominante : le moteur suit tes objectifs tels quels.",
};

export const PAIN_LOCATION_LABEL_FR: Record<PainLocation, string> = {
  neck: "Cou",
  shoulder: "Épaule",
  elbow: "Coude",
  wrist: "Poignet",
  upper_back: "Haut du dos",
  lower_back: "Bas du dos",
  hip: "Hanche",
  groin: "Aine",
  knee: "Genou",
  shin: "Tibia",
  calf: "Mollet",
  achilles: "Tendon d'Achille",
  ankle: "Cheville",
  foot: "Pied",
  hamstring: "Ischio",
  quad: "Quadriceps",
  other: "Autre",
};

export const SIDE_LABEL_FR: Record<string, string> = {
  left: "gauche",
  right: "droite",
  both: "des deux côtés",
};

export const WEEKDAY_LABEL_FR = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"] as const;

/** The three onboarding availability slots (athlete-local minutes). */
export const DAY_SLOTS = [
  { key: "morning", label: "Matin", hint: "6:00 – 9:00", startMinute: 360, endMinute: 540 },
  { key: "noon", label: "Midi", hint: "11:30 – 14:00", startMinute: 690, endMinute: 840 },
  { key: "evening", label: "Soir", hint: "17:30 – 21:00", startMinute: 1050, endMinute: 1260 },
] as const;
export type DaySlotKey = (typeof DAY_SLOTS)[number]["key"];

export const PR_LIFT_LABEL_FR: Record<string, string> = {
  back_squat: "Back squat",
  front_squat: "Front squat",
  deadlift: "Deadlift",
  bench_press: "Développé couché",
  strict_press: "Strict press",
  clean: "Clean",
  snatch: "Snatch",
};

/** Short IANA list for the timezone select. */
export const TIMEZONES = [
  "Europe/Paris",
  "Europe/London",
  "Europe/Brussels",
  "Europe/Zurich",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Lisbon",
  "Europe/Rome",
  "Indian/Reunion",
  "America/Martinique",
  "America/Montreal",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Dubai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "UTC",
] as const;

export const ONBOARDING_STEPS = [
  { step: 1, title: "Objectifs", hint: "Ce qui compte pour toi" },
  { step: 2, title: "Sports & matériel", hint: "Où et avec quoi tu t'entraînes" },
  { step: 3, title: "Disponibilités", hint: "Ton temps réel" },
  { step: 4, title: "Niveau", hint: "Repères optionnels" },
  { step: 5, title: "Garmin", hint: "Connexion" },
] as const;
export const ONBOARDING_STEP_COUNT = ONBOARDING_STEPS.length;

export const FLAG_KEYS = [
  "garmin",
  "aiCoach",
  "bodyComp",
  "advancedReadiness",
  "experimentalMetrics",
] as const;
export type FlagKey = (typeof FLAG_KEYS)[number];

export const FLAG_LABEL_FR: Record<FlagKey, { label: string; hint: string }> = {
  garmin: { label: "Garmin", hint: "Synchronisation Garmin (API officielle)" },
  aiCoach: { label: "Coach IA", hint: "Chat, explications et suggestions fun" },
  bodyComp: { label: "Composition corporelle", hint: "Balance connectée et tendances" },
  advancedReadiness: { label: "Readiness avancée", hint: "HRV, sommeil, Body Battery" },
  experimentalMetrics: { label: "Métriques expérimentales", hint: "Découplage, EF, pace@HR" },
};

export function weekdayLabel(weekday: number): string {
  return WEEKDAY_LABEL_FR[weekday] ?? "";
}

/** Qualitative word for a 0..1 goal weight (spec §34: "très élevée / élevée / moyenne / variable"). */
export function weightWord(w: number): string {
  if (w >= 0.95) return "Très élevé";
  if (w >= 0.75) return "Élevé";
  if (w >= 0.45) return "Moyen";
  if (w > 0) return "Faible";
  return "Ignoré";
}
