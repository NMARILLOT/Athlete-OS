import { bestE1rm, roundToIncrement, weightForRepsAtRpe } from "./e1rm";
import { QUALITY_TO_RPE, type ExposureRecord, type SetRecord, type StrengthPrescription } from "./types";

export const PROGRESSION_ALGORITHM_VERSION = "autoload_v1" as const;

export type ProgressionAction = "increase" | "hold" | "decrease" | "start" | "unknown";

export interface ProgressionDecision {
  action: ProgressionAction;
  /** Suggested working weight for the next exposure; null when the athlete must pick. */
  nextWeightKg: number | null;
  deltaKg: number;
  /** Stable rule id for explanations/tests. */
  ruleId:
    | "ALL_SETS_TOP_OF_RANGE_WITH_RIR"
    | "TARGET_MET_BUT_HARD"
    | "MULTIPLE_SETS_MISSED"
    | "FIRST_EXPOSURE_FROM_E1RM"
    | "FIRST_EXPOSURE_NO_DATA"
    | "INCOMPLETE_DATA_HOLD";
  reason: string;
  algorithmVersion: typeof PROGRESSION_ALGORITHM_VERSION;
}

export interface ProgressionInput {
  prescription: Pick<StrengthPrescription, "sets" | "repMin" | "repMax" | "targetRpeMin" | "targetRpeMax">;
  /** Most recent exposure first. Only the latest is used for the decision; older ones feed e1RM. */
  history: ExposureRecord[];
  /** Plate increment available for this exercise (kg). */
  incrementKg: number;
  /** Optional known e1RM (kg) to seed a first exposure. */
  knownE1rmKg?: number | null;
}

function effectiveRpe(s: SetRecord): number | null {
  if (typeof s.rpe === "number") return s.rpe;
  if (s.quality) return QUALITY_TO_RPE[s.quality];
  return null;
}

function workingSets(sets: SetRecord[]): SetRecord[] {
  return sets.filter((s) => !s.isWarmup && s.reps >= 0 && s.weightKg > 0);
}

/**
 * Deterministic autoload (spec §11, §79).
 *  - every working set reached repMax with RPE ≤ targetRpeMax − 0.5 → increase by one increment
 *    (two increments when RPE ≤ targetRpeMin − 0.5, i.e. clearly too easy)
 *  - target met (all sets ≥ repMin) but hard → hold
 *  - two or more sets under repMin, or any failed set → decrease ~5 % rounded to increment
 */
export function decideProgression(input: ProgressionInput): ProgressionDecision {
  const { prescription, history, incrementKg } = input;
  const last = history[0];

  if (!last || workingSets(last.sets).length === 0) {
    const e1rm = input.knownE1rmKg ?? bestE1rmFromHistory(history);
    if (e1rm) {
      const target = weightForRepsAtRpe(e1rm, prescription.repMax, prescription.targetRpeMin);
      const w = roundToIncrement(target, incrementKg);
      return {
        action: "start",
        nextWeightKg: w,
        deltaKg: 0,
        ruleId: "FIRST_EXPOSURE_FROM_E1RM",
        reason: `Première exposition : ${w} kg dérivé de ton e1RM (${Math.round(e1rm)} kg) pour ${prescription.repMax} reps @ RPE ${prescription.targetRpeMin}.`,
        algorithmVersion: PROGRESSION_ALGORITHM_VERSION,
      };
    }
    return {
      action: "unknown",
      nextWeightKg: null,
      deltaKg: 0,
      ruleId: "FIRST_EXPOSURE_NO_DATA",
      reason: "Pas d'historique : choisis une charge confortable, l'app apprend à partir de cette séance.",
      algorithmVersion: PROGRESSION_ALGORITHM_VERSION,
    };
  }

  const sets = workingSets(last.sets);
  const lastWeight = Math.max(...sets.map((s) => s.weightKg));
  const rpes = sets.map(effectiveRpe).filter((r): r is number => r !== null);
  const avgRpe = rpes.length ? rpes.reduce((a, b) => a + b, 0) / rpes.length : null;
  const failed = sets.filter((s) => s.quality === "failed" || s.reps === 0).length;
  const underMin = sets.filter((s) => s.reps < prescription.repMin).length;
  const allAtTop = sets.every((s) => s.reps >= prescription.repMax);
  const allAtLeastMin = sets.every((s) => s.reps >= prescription.repMin);
  const enoughSets = sets.length >= Math.max(1, prescription.sets - 1);

  if (failed >= 1 || underMin >= 2) {
    const raw = lastWeight * 0.95;
    const w = Math.max(incrementKg, roundToIncrement(raw, incrementKg));
    const delta = w - lastWeight;
    return {
      action: "decrease",
      nextWeightKg: w === lastWeight ? lastWeight - incrementKg : w,
      deltaKg: w === lastWeight ? -incrementKg : delta,
      ruleId: "MULTIPLE_SETS_MISSED",
      reason: `${failed >= 1 ? "Échec" : "Plusieurs séries sous la cible"} la dernière fois à ${lastWeight} kg : on baisse légèrement pour reconstruire des séries propres.`,
      algorithmVersion: PROGRESSION_ALGORITHM_VERSION,
    };
  }

  if (!enoughSets || avgRpe === null) {
    return {
      action: "hold",
      nextWeightKg: lastWeight,
      deltaKg: 0,
      ruleId: "INCOMPLETE_DATA_HOLD",
      reason: `Données incomplètes sur la dernière exposition : on garde ${lastWeight} kg.`,
      algorithmVersion: PROGRESSION_ALGORITHM_VERSION,
    };
  }

  if (allAtTop && avgRpe <= prescription.targetRpeMax - 0.5) {
    const steps = avgRpe <= prescription.targetRpeMin - 0.5 ? 2 : 1;
    const w = roundToIncrement(lastWeight + steps * incrementKg, incrementKg);
    return {
      action: "increase",
      nextWeightKg: w,
      deltaKg: w - lastWeight,
      ruleId: "ALL_SETS_TOP_OF_RANGE_WITH_RIR",
      reason: `Toutes les séries à ${prescription.repMax} reps avec de la marge (RPE moyen ${avgRpe.toFixed(1)}) : +${w - lastWeight} kg proposé.`,
      algorithmVersion: PROGRESSION_ALGORITHM_VERSION,
    };
  }

  if (allAtLeastMin) {
    return {
      action: "hold",
      nextWeightKg: lastWeight,
      deltaKg: 0,
      ruleId: "TARGET_MET_BUT_HARD",
      reason: `Cible atteinte mais ${avgRpe >= prescription.targetRpeMax ? "difficile" : "pas encore en haut de plage"} (RPE ${avgRpe.toFixed(1)}) : on consolide ${lastWeight} kg.`,
      algorithmVersion: PROGRESSION_ALGORITHM_VERSION,
    };
  }

  return {
    action: "hold",
    nextWeightKg: lastWeight,
    deltaKg: 0,
    ruleId: "INCOMPLETE_DATA_HOLD",
    reason: `Une série sous la cible : on garde ${lastWeight} kg et on vise des séries complètes.`,
    algorithmVersion: PROGRESSION_ALGORITHM_VERSION,
  };
}

function bestE1rmFromHistory(history: ExposureRecord[]): number | null {
  let best: number | null = null;
  for (const h of history) {
    const b = bestE1rm(h.sets);
    if (b && (best === null || b.e1rmKg > best)) best = b.e1rmKg;
  }
  return best;
}
