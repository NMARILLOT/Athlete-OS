import type { GoalKey, GoalWeights, StimulusKey } from "../core";

/**
 * How much each stimulus serves each goal (0..1). Static, documented, used to weight gap coverage:
 *   w_k = 0.5 + 0.5 × Σ_g affinity[k][g] × goalWeight[g]
 * The 0.5 floor implements spec §36: a dominant goal never erases the other capacities.
 */
export const STIMULUS_GOAL_AFFINITY: Record<StimulusKey, Partial<Record<GoalKey, number>>> = {
  strength_lower: {
    strength: 0.6,
    crossfit: 0.3,
    physique: 0.3,
    health_longevity: 0.3,
    event_hyrox: 0.2,
  },
  strength_upper: { strength: 0.6, crossfit: 0.3, physique: 0.4, health_longevity: 0.3 },
  hypertrophy: { physique: 0.6, strength: 0.3, health_longevity: 0.3 },
  olympic_technique: {
    crossfit: 0.6,
    strength: 0.2,
    lift_clean: 0.8,
    lift_snatch: 0.8,
    event_open: 0.5,
  },
  gymnastics_skill: {
    crossfit: 0.6,
    skill_muscle_up: 0.9,
    skill_handstand_walk: 0.9,
    event_open: 0.5,
    fun: 0.2,
  },
  aerobic_easy: {
    endurance: 0.5,
    health_longevity: 0.5,
    zone2_capacity: 0.9,
    event_5k: 0.3,
    event_10k: 0.4,
    event_trail: 0.5,
    event_hyrox: 0.4,
  },
  aerobic_long: {
    endurance: 0.6,
    health_longevity: 0.3,
    zone2_capacity: 0.6,
    event_10k: 0.5,
    event_trail: 0.8,
    event_hyrox: 0.4,
  },
  threshold: { endurance: 0.6, event_5k: 0.7, event_10k: 0.7, event_hyrox: 0.6, crossfit: 0.2 },
  vo2max: { endurance: 0.5, crossfit: 0.4, health_longevity: 0.3, event_5k: 0.6, event_open: 0.3 },
  power: { strength: 0.4, crossfit: 0.4, lift_clean: 0.4, lift_snatch: 0.4 },
  crossfit_exposure: { crossfit: 0.8, fun: 0.4, event_open: 0.6 },
  hi_conditioning: { crossfit: 0.6, endurance: 0.2, event_open: 0.6, event_hyrox: 0.4 },
  mobility_recovery: { health_longevity: 0.6, fun: 0.1 },
};

/** Normalise goal weights so the strongest goal is 1 (weights are relative priorities, spec §35). */
export function normalizeGoalWeights(weights: GoalWeights): GoalWeights {
  const entries = Object.entries(weights).filter(
    ([, v]) => typeof v === "number" && v > 0,
  ) as Array<[GoalKey, number]>;
  const max = entries.reduce((m, [, v]) => Math.max(m, v), 0);
  if (max <= 0) return {};
  const out: GoalWeights = {};
  for (const [k, v] of entries) out[k] = v / max;
  return out;
}

export function stimulusWeight(key: StimulusKey, goalWeights: GoalWeights): number {
  const affinity = STIMULUS_GOAL_AFFINITY[key];
  let sum = 0;
  for (const [goal, a] of Object.entries(affinity) as Array<[GoalKey, number]>) {
    sum += a * (goalWeights[goal] ?? 0);
  }
  return Math.min(1.5, 0.5 + 0.5 * sum);
}
