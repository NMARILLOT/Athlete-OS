import {
  HR_ZONE_CEILING_BPM,
  type CardioPresetKind,
  type CardioStep,
  type CardioStepKind,
  type CardioTarget,
  type CardioTargetType,
  type HrZone,
} from "@/domain/cardio";
import type { CardioKind, IntensityBand, Modality, WorkoutStatus } from "@/domain/core";

/**
 * French labels and describers for the cardio builder island (client side). The stored view of a
 * workout carries the same labels computed server side by `cardio.service.ts`; both must render a
 * target the same way ("Z2 (145–152 bpm)") so the live preview matches the saved session.
 */

export const MODALITY_FR: Record<Modality, string> = {
  running: "Course",
  bike: "Vélo",
  row: "Rameur",
  ski: "SkiErg",
  swimming: "Natation",
  walking: "Marche",
  strength: "Force",
  gymnastics: "Gymnastique",
  weightlifting: "Haltéro",
  mixed_modal: "Mixte",
  mobility: "Mobilité",
  other: "Autre",
};

/** Modalities the builder offers (the others are not cardio sessions). */
export const BUILDER_MODALITIES: readonly Modality[] = [
  "running",
  "bike",
  "row",
  "ski",
  "walking",
  "swimming",
  "other",
];

export const CARDIO_KIND_FR: Record<CardioKind, string> = {
  zone2: "Zone 2",
  long: "Sortie longue",
  recovery: "Récupération",
  tempo: "Tempo",
  threshold: "Seuil",
  vo2max: "VO2max",
  intervals: "Intervalles",
  fartlek: "Fartlek",
  hills: "Côtes",
  strides: "Lignes droites",
  test: "Test",
  free: "Libre",
};

export const STEP_KIND_FR: Record<CardioStepKind, string> = {
  warmup: "Échauffement",
  work: "Effort",
  recovery: "Récup",
  cooldown: "Retour au calme",
  rest: "Repos",
  repeat: "Répétition",
};

export const TARGET_TYPE_FR: Record<CardioTargetType, string> = {
  hr_zone: "Zone",
  hr_bpm: "FC (bpm)",
  pace_sec_km: "Allure",
  power_w: "Puissance",
  cadence: "Cadence",
  open: "Libre",
};

export const INTENSITY_FR: Record<IntensityBand, string> = {
  easy: "facile",
  moderate: "modérée",
  hard: "dure",
};

export const STATUS_FR: Record<WorkoutStatus, string> = {
  planned: "Prévue",
  in_progress: "En cours",
  done: "Terminée",
  skipped: "Sautée",
  auto_adjusted: "Replanifiée",
};

/** Preset picker groups (spec §12 session families). */
export const PRESET_GROUPS: ReadonlyArray<{ title: string; kinds: readonly CardioPresetKind[] }> = [
  {
    title: "Course",
    kinds: [
      "run_easy_45",
      "run_easy_60",
      "run_long_90",
      "run_tempo",
      "run_threshold",
      "run_vo2",
      "strides",
    ],
  },
  { title: "Vélo", kinds: ["bike_easy_60", "bike_long_120", "bike_intervals"] },
  { title: "Rameur & SkiErg", kinds: ["row_easy_30", "row_intervals", "ski_easy_30"] },
  { title: "Marche & récup", kinds: ["walk_45", "recovery_spin_30"] },
  { title: "Tests", kinds: ["test_run_5k", "test_row_2k"] },
];

export function formatSeconds(sec: number): string {
  if (sec < 60) return `${Math.round(sec)} s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h > 0) return s === 0 ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h ${m} min ${s} s`;
  return s === 0 ? `${m} min` : `${m}:${String(s).padStart(2, "0")}`;
}

export function formatPaceClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function describeRange(
  min: number | undefined,
  max: number | undefined,
  format: (v: number) => string,
  unit: string,
): string | null {
  if (min != null && max != null)
    return min === max ? `${format(min)}${unit}` : `${format(min)}–${format(max)}${unit}`;
  if (min != null) return `≥ ${format(min)}${unit}`;
  if (max != null) return `≤ ${format(max)}${unit}`;
  return null;
}

/** Same rendering as `describeCardioTarget` in the service (kept in sync by hand). */
export function describeTarget(
  target: CardioTarget | null | undefined,
  zones: readonly HrZone[] | null,
): string {
  if (!target || target.type === "open") return "libre";
  const plain = String;
  switch (target.type) {
    case "hr_zone": {
      const z = target.zone;
      if (z == null) return "zone FC";
      const band = zones?.find((b) => b.zone === z);
      if (!band) return `Z${z}`;
      if (band.minBpm <= 0) return `Z${z} (≤ ${band.maxBpm} bpm)`;
      if (band.maxBpm >= HR_ZONE_CEILING_BPM) return `Z${z} (≥ ${band.minBpm} bpm)`;
      return `Z${z} (${band.minBpm}–${band.maxBpm} bpm)`;
    }
    case "hr_bpm":
      return describeRange(target.min, target.max, plain, " bpm") ?? "FC";
    case "pace_sec_km":
      return describeRange(target.min, target.max, formatPaceClock, " /km") ?? "allure";
    case "power_w":
      return describeRange(target.min, target.max, plain, " W") ?? "puissance";
    case "cadence":
      return describeRange(target.min, target.max, plain, " /min") ?? "cadence";
  }
}

export function describeExtent(step: Pick<CardioStep, "durationSec" | "distanceM">): string {
  if (step.durationSec != null && step.durationSec > 0) return formatSeconds(step.durationSec);
  if (step.distanceM != null && step.distanceM > 0)
    return step.distanceM >= 1000
      ? `${(step.distanceM / 1000).toFixed(step.distanceM % 1000 === 0 ? 0 : 2).replace(".", ",")} km`
      : `${Math.round(step.distanceM)} m`;
  return "au bouton lap";
}
