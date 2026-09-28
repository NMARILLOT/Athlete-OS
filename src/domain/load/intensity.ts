import type { CardioKind, IntensityBand, LoadVector } from "../core";

export const INTENSITY_ALGORITHM_VERSION = "intensity_classifier_v1" as const;

export interface IntensityInput {
  loadVector?: LoadVector | null;
  /** Minutes spent in HR zones 1..5 when known (Garmin/FIT). */
  minutesInZones?: { z1: number; z2: number; z3: number; z4: number; z5: number } | null;
  cardioKind?: CardioKind | null;
  /** For CrossFit metcons: time domain in minutes and whether it uses high-rate movements. */
  metcon?: { timeDomainMin: number; highRate: boolean } | null;
  isBenchmark?: boolean;
  rpe?: number | null;
  /** Strength work at RPE ≥ 8 (heavy) — moderate on the metabolic axis, tracked separately. */
  heavyStrength?: boolean;
}

export interface IntensityDecision {
  band: IntensityBand;
  reason: string;
  source: "CALCULATED";
  algorithmVersion: typeof INTENSITY_ALGORITHM_VERSION;
}

/**
 * Deterministic intensity on the METABOLIC axis (ENGINE.md). Heavy strength is not "hard" here:
 * its cost is captured by muscular residual fatigue and the separate heavy-strength budget.
 */
export function classifyIntensity(input: IntensityInput): IntensityDecision {
  const done = (band: IntensityBand, reason: string): IntensityDecision => ({ band, reason, source: "CALCULATED", algorithmVersion: INTENSITY_ALGORITHM_VERSION });
  const z = input.minutesInZones;
  if (z && z.z4 + z.z5 >= 10) return done("hard", `≥ 10 min en Z4–Z5 (${Math.round(z.z4 + z.z5)} min)`);
  if (input.cardioKind && ["threshold", "vo2max", "intervals", "test"].includes(input.cardioKind)) return done("hard", `séance ${input.cardioKind}`);
  if (input.isBenchmark) return done("hard", "benchmark");
  if (input.metcon && input.metcon.timeDomainMin <= 20 && input.metcon.highRate) return done("hard", "metcon court à haute cadence");
  const cardio = input.loadVector?.cardiovascular ?? null;
  if (cardio !== null && cardio >= 7) return done("hard", `charge cardio ${cardio}/10`);
  if (typeof input.rpe === "number" && input.rpe >= 8 && !input.heavyStrength && (cardio === null || cardio >= 5)) return done("hard", `RPE ${input.rpe}`);

  if (z && z.z3 >= 20) return done("moderate", `≥ 20 min en Z3`);
  if (cardio !== null && cardio >= 4) return done("moderate", `charge cardio ${cardio}/10`);
  if (input.heavyStrength) return done("moderate", "force lourde (RPE ≥ 8)");
  if (input.cardioKind === "tempo" || input.cardioKind === "fartlek" || input.cardioKind === "hills") return done("moderate", `séance ${input.cardioKind}`);
  if (input.metcon && input.metcon.timeDomainMin > 20) return done("moderate", "metcon long");
  if (typeof input.rpe === "number" && input.rpe >= 6) return done("moderate", `RPE ${input.rpe}`);
  return done("easy", "aucun signal d'intensité élevée");
}

/** Heavy strength: any working set at RPE ≥ 8 (or quality hard/failed) on a compound lift. */
export function isHeavyStrengthSession(sets: ReadonlyArray<{ rpe?: number | null; quality?: string | null; isWarmup?: boolean }>): boolean {
  return sets.some((s) => !s.isWarmup && ((typeof s.rpe === "number" && s.rpe >= 8) || s.quality === "hard" || s.quality === "failed"));
}
