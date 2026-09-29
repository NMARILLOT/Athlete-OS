import type { Modality } from "@/domain/core";

/** French labels shared by the activities list and detail (client-safe: domain types only). */
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
  other: "Activité",
};

export const MODALITY_EMOJI: Record<Modality, string> = {
  running: "🏃",
  bike: "🚴",
  row: "🚣",
  ski: "⛷️",
  swimming: "🏊",
  walking: "🚶",
  strength: "🏋️",
  gymnastics: "🤸",
  weightlifting: "🏋️",
  mixed_modal: "🔥",
  mobility: "🧘",
  other: "⌚",
};

export const PROVIDER_FR: Record<string, string> = {
  garmin: "Garmin",
  fit_import: "Fichier FIT",
  manual: "Manuel",
};

const INTENSITY_FR: Record<string, string> = { easy: "facile", moderate: "modérée", hard: "dure" };
const MODALITY_TOKEN_FR: Record<string, string> = {
  run: "course",
  bike: "vélo",
  row: "rameur",
  ski: "ski",
  swim: "natation",
  walk: "marche",
  strength: "force",
  gymnastics: "gym",
  weightlifting: "haltéro",
  mixed_modal: "mixte",
  mobility: "mobilité",
  other: "autre",
};
const TOKEN_FR: Record<string, string> = {
  flat: "plat",
  hilly: "vallonné",
  indoor: "intérieur",
  outdoor: "extérieur",
  under45min: "< 45 min",
  "45_75min": "45–75 min",
  "75_120min": "75–120 min",
  over120min: "> 120 min",
};

/** `easy_run_flat_45_75min` → "course facile · plat · 45–75 min". */
export function describeComparableGroup(key: string): string {
  const parts = key.split("_");
  const intensity = parts.shift() ?? "";
  // Duration buckets contain underscores: rebuild them from the tail.
  let duration = "";
  for (const candidate of ["45_75min", "75_120min"]) {
    if (key.endsWith(`_${candidate}`)) duration = candidate;
  }
  if (!duration) duration = parts[parts.length - 1] ?? "";
  const middle = key
    .slice(intensity.length + 1, key.length - duration.length - 1)
    .split("_")
    .filter(Boolean);
  const modalityToken = middle.shift() ?? "";
  const out = [
    `${MODALITY_TOKEN_FR[modalityToken] ?? modalityToken} ${INTENSITY_FR[intensity] ?? intensity}`.trim(),
    ...middle.map((t) => TOKEN_FR[t] ?? t),
    TOKEN_FR[duration] ?? duration,
  ];
  return out.filter(Boolean).join(" · ");
}
