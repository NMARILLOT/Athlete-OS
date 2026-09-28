import type { LoadDimension, LoadVector, StimulusKey } from "../core";

/**
 * Athlete-model defaults (ENGINE.md §3). These are sports-science priors, NOT measurements.
 * Every value here may be overridden by a learned `athlete_model_params` row; the engine
 * receives the merged result as `AthleteModelParams`.
 *
 * Scale reminders: a single session's loadVector is 0..10 per dimension; residual fatigue is the
 * decayed sum over the last 28 days on the same scale.
 */

/** Hours. Force/DOMS recovery 48–72 h after heavy eccentric lower work; autonomic 24–48 h after HIIT. */
export const DEFAULT_HALF_LIVES_H: Record<LoadDimension, number> = {
  cardiovascular: 20,
  muscular_lower: 36,
  muscular_upper: 30,
  impact: 30,
  eccentric: 48,
  technical: 18,
};

/**
 * Tolerance = residual level at which a same-dimension heavy stimulus is vetoed.
 * Check: heavy squat 5×5 (lower 8) → 5.45 at +20 h (veto), 3.2 at +48 h (allowed).
 */
export const DEFAULT_TOLERANCE: Record<LoadDimension, number> = {
  cardiovascular: 6.0,
  muscular_lower: 5.0,
  muscular_upper: 5.0,
  impact: 4.5,
  eccentric: 6.0,
  technical: 5.0,
};

/** Reference load vectors for the candidate catalog and the unknown-WOD prior. */
export const REFERENCE_LOAD: Record<string, LoadVector> = {
  heavy_squat_5x5: {
    cardiovascular: 2,
    muscular_lower: 8,
    muscular_upper: 2,
    impact: 0,
    eccentric: 7,
    technical: 4,
  },
  heavy_upper: {
    cardiovascular: 2,
    muscular_lower: 0.5,
    muscular_upper: 8,
    impact: 0,
    eccentric: 4,
    technical: 2,
  },
  amrap_12_wb_burpee_row: {
    cardiovascular: 8,
    muscular_lower: 5,
    muscular_upper: 4,
    impact: 5,
    eccentric: 3,
    technical: 2,
  },
  z2_run_60: {
    cardiovascular: 3,
    muscular_lower: 2.5,
    muscular_upper: 0,
    impact: 5,
    eccentric: 2,
    technical: 0,
  },
  z2_bike_60: {
    cardiovascular: 3,
    muscular_lower: 2,
    muscular_upper: 0,
    impact: 0,
    eccentric: 0,
    technical: 0,
  },
  vo2_run: {
    cardiovascular: 9,
    muscular_lower: 5,
    muscular_upper: 0,
    impact: 7,
    eccentric: 4,
    technical: 1,
  },
  threshold_bike: {
    cardiovascular: 8,
    muscular_lower: 5,
    muscular_upper: 0,
    impact: 0,
    eccentric: 0,
    technical: 0,
  },
  mobility: {
    cardiovascular: 0.5,
    muscular_lower: 0.5,
    muscular_upper: 0.5,
    impact: 0,
    eccentric: 0,
    technical: 0,
  },
  /** Prior for a fixed CrossFit class whose WOD is unknown. */
  crossfit_class_prior: {
    cardiovascular: 7,
    muscular_lower: 5,
    muscular_upper: 4,
    impact: 4,
    eccentric: 4,
    technical: 4,
  },
};

/** Credits prior for an unknown box class (confidence 0.4). */
export const CROSSFIT_CLASS_PRIOR_CREDITS: Partial<Record<StimulusKey, number>> = {
  crossfit_exposure: 1,
  hi_conditioning: 0.7,
  strength_lower: 0.4,
  strength_upper: 0.3,
  gymnastics_skill: 0.3,
  olympic_technique: 0.2,
};
export const CROSSFIT_CLASS_PRIOR_CONFIDENCE = 0.4;

/**
 * Impact units (IU), spec §47. 1 IU ≈ 1 km of running.
 * Session impact dimension = min(10, 1.2 × IU).
 */
export const IMPACT_UNITS = {
  perRunKm: 1,
  perDoubleUnder: 1 / 200,
  perSingleUnder: 1 / 600,
  perBoxJump: 1 / 30,
  perBurpee: 1 / 30,
  perJumpingLunge: 1 / 40,
  perWalkKm: 0.25,
} as const;
export const IMPACT_DIM_PER_IU = 1.2;
/** Weekly impact tolerance = max(floor, factor × mean weekly IU of the last 4 weeks). */
export const IMPACT_WEEKLY_TOLERANCE = { floorIU: 12, factor: 1.2 } as const;

/** Actual-vs-planned scaling of a template load vector (ENGINE.md §3). */
export const ACTUAL_SCALING = {
  rpeRatioMin: 0.6,
  rpeRatioMax: 1.4,
  durationRatioMin: 0.7,
  durationRatioMax: 1.3,
} as const;

/** Readiness signal thresholds (each fires one "signal"; poor = ≥ 2 signals). */
export const READINESS_SIGNALS = {
  rhrAboveMedianBpm: 5,
  rhrAboveMedianPct: 7,
  hrvBelowMeanSd: 0.5,
  hrvBelowMeanPct: 10,
  sleepBelowHours: 6,
  sleepBelowMedianHours: 1.5,
  bodyBatteryBelow: 35,
} as const;

/** "Fresh" (TEST_OPPORTUNITY): all fatigue ratios ≤ 0.4, readiness good, no hard in 48 h, no test in 14 d. */
export const FRESHNESS = { maxFatigueRatio: 0.4, noHardHours: 48, noTestDays: 14 } as const;

/** Daily session-RPE load cap = max(minAU, factor × 28-day mean daily load). */
export const DAILY_LOAD_CAP = { minAU: 500, factor: 1.3 } as const;

/** Weekly structure defaults (spec §8). */
export const WEEKLY_STRUCTURE = {
  maxHardSessions: 3,
  maxHeavyStrength: 3,
  maxDoubles: 2,
  baselineMaxHardEngineProposed: 2,
  minRestDaysPerWeek: 1,
} as const;

/** Box prior learning (per weekday WOD pattern): EWMA α over the last 8 same-weekday analyses. */
export const BOX_PRIOR = {
  alpha: 0.3,
  maxSamples: 8,
  minConfidenceToUse: 0.5,
  samplesForFullConfidence: 6,
} as const;

/** Deload (spec §42) — signals counted by evaluateDeload, multipliers applied while active. */
export const DELOAD = {
  reactiveSignals: 3,
  reactivePainIntensity: 6,
  preventiveAfterWeeks: 4,
  preventiveMinAchievement: 0.85,
  durationDays: 6,
  multipliers: {
    volumeKeys: 0.6,
    hardKeys: 0.5,
    aerobicEasy: 0.8,
    mobility: 1.5,
    impactTolerance: 0.5,
    strengthSets: 0.6,
  },
  strengthMaxRpe: 7,
  maxHardSessions: 1,
} as const;
