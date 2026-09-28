import {
  HARD_STIMULUS_KEYS,
  STIMULUS_KEY_VALUES,
  STIMULUS_WINDOW_DAYS,
  type BlockFocus,
  type GoalWeights,
  type StimulusKey,
} from "../core";
import { DELOAD, WEEKLY_STRUCTURE } from "../athlete-model/defaults";
import { normalizeGoalWeights } from "./affinity";

export type StimulusTargets = Record<StimulusKey, number>;

/**
 * Default targets (spec §8), expressed per key window (see STIMULUS_WINDOW_DAYS):
 * 7-day keys are "per week", 14-day keys are "per two weeks".
 */
export const DEFAULT_TARGETS: StimulusTargets = {
  strength_lower: 1.5,
  strength_upper: 1.5,
  hypertrophy: 1,
  olympic_technique: 1,
  gymnastics_skill: 1,
  aerobic_easy: 3,
  aerobic_long: 1,
  threshold: 1, // per 14 d
  vo2max: 1, // per 14 d
  power: 1, // per 14 d
  crossfit_exposure: 3,
  hi_conditioning: 2,
  mobility_recovery: 2,
};

const BLOCK_MULTIPLIERS: Record<BlockFocus, Partial<StimulusTargets>> = {
  base: {
    aerobic_easy: 1.3,
    aerobic_long: 1.3,
    hi_conditioning: 0.75,
    vo2max: 0.75,
    strength_lower: 1,
    strength_upper: 1,
  },
  build: { threshold: 1.5, strength_lower: 1.2, strength_upper: 1.2, aerobic_easy: 1.1 },
  performance: {
    crossfit_exposure: 1.3,
    hi_conditioning: 1.2,
    vo2max: 1.2,
    olympic_technique: 1.2,
    gymnastics_skill: 1.2,
    aerobic_long: 0.8,
  },
  recovery: {
    strength_lower: 0.6,
    strength_upper: 0.6,
    hypertrophy: 0.6,
    hi_conditioning: 0.5,
    threshold: 0.5,
    vo2max: 0.5,
    aerobic_easy: 0.8,
    mobility_recovery: 1.5,
  },
  custom: {},
};

/** Goal-driven nudges: a strong specific goal raises its stimuli (never above 1.5×). */
function goalMultipliers(goalWeights: GoalWeights): Partial<StimulusTargets> {
  const g = normalizeGoalWeights(goalWeights);
  const m: Partial<StimulusTargets> = {};
  const bump = (k: StimulusKey, w: number | undefined, factor: number) => {
    if (w && w >= 0.6) m[k] = Math.max(m[k] ?? 1, 1 + (factor - 1) * w);
  };
  bump("threshold", g.event_5k, 1.4);
  bump("threshold", g.event_10k, 1.4);
  bump("threshold", g.event_hyrox, 1.3);
  bump("aerobic_long", g.event_trail, 1.5);
  bump("aerobic_easy", g.zone2_capacity, 1.3);
  bump("olympic_technique", g.lift_clean, 1.5);
  bump("olympic_technique", g.lift_snatch, 1.5);
  bump("gymnastics_skill", g.skill_muscle_up, 1.5);
  bump("gymnastics_skill", g.skill_handstand_walk, 1.5);
  bump("crossfit_exposure", g.event_open, 1.3);
  bump("hypertrophy", g.physique, 1.3);
  return m;
}

export interface DeriveTargetsInput {
  goalWeights: GoalWeights;
  blockFocus?: BlockFocus;
  /** Progressive weekly hours target (spec §8: 8→12 h over months). 8 h is the reference. */
  weeklyHoursTarget?: number;
  maxHardSessionsPerWeek?: number;
  deloadActive?: boolean;
  /** Explicit user/block overrides win over everything else (spec §35). */
  overrides?: Partial<StimulusTargets>;
}

/** Weekly-equivalent hard exposures implied by the targets (14-day keys count half). */
export function weeklyHardExposures(targets: StimulusTargets): number {
  return HARD_STIMULUS_KEYS.reduce((sum, k) => sum + (targets[k] * 7) / STIMULUS_WINDOW_DAYS[k], 0);
}

/**
 * Derive stimulus targets from goals, block, volume and deload state.
 * Post-conditions (tested):
 *  - no key below 50 % of its default ("a dominant never erases the others", spec §36) unless deload
 *  - Σ weekly hard exposures ≤ maxHardSessionsPerWeek
 */
export function deriveWeeklyTargets(input: DeriveTargetsInput): StimulusTargets {
  const maxHard = input.maxHardSessionsPerWeek ?? WEEKLY_STRUCTURE.maxHardSessions;
  const block = BLOCK_MULTIPLIERS[input.blockFocus ?? "custom"];
  const goals = goalMultipliers(input.goalWeights);
  const hoursFactor = Math.min(1.5, Math.max(0.7, (input.weeklyHoursTarget ?? 8) / 8));

  const out = { ...DEFAULT_TARGETS };
  for (const k of STIMULUS_KEY_VALUES) {
    let v = DEFAULT_TARGETS[k] * (block[k] ?? 1) * (goals[k] ?? 1);
    if (k === "aerobic_easy" || k === "aerobic_long" || k === "hypertrophy") v *= hoursFactor;
    v = Math.max(v, DEFAULT_TARGETS[k] * 0.5);
    out[k] = v;
  }

  if (input.deloadActive) {
    const m = DELOAD.multipliers;
    for (const k of STIMULUS_KEY_VALUES) {
      if (HARD_STIMULUS_KEYS.includes(k)) out[k] *= m.hardKeys;
      else if (k === "aerobic_easy") out[k] *= m.aerobicEasy;
      else if (k === "mobility_recovery") out[k] *= m.mobility;
      else out[k] *= m.volumeKeys;
    }
  }

  for (const [k, v] of Object.entries(input.overrides ?? {}) as Array<
    [StimulusKey, number | undefined]
  >) {
    if (typeof v === "number" && v >= 0) out[k] = v;
  }

  // Hard budget post-condition: scale hard keys proportionally (overrides included — safety wins).
  const cap = input.deloadActive ? Math.min(maxHard, DELOAD.maxHardSessions) : maxHard;
  const hard = weeklyHardExposures(out);
  if (hard > cap) {
    const f = cap / hard;
    for (const k of HARD_STIMULUS_KEYS) out[k] *= f;
  }

  for (const k of STIMULUS_KEY_VALUES) out[k] = Math.round(out[k] * 100) / 100;
  // Rounding may nudge the hard sum above the cap by a hundredth: floor hard keys once more.
  if (weeklyHardExposures(out) > cap) {
    const f = cap / weeklyHardExposures(out);
    for (const k of HARD_STIMULUS_KEYS) out[k] = Math.floor(out[k] * f * 100) / 100;
  }
  return out;
}
