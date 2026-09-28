import type { LoadDimension } from "../core";

/** Merged athlete-model parameters passed to the engine (defaults + learned overrides). */
export interface AthleteModelParams {
  halfLivesH: Record<LoadDimension, number>;
  tolerance: Record<LoadDimension, number>;
  /** Per-exercise cost multipliers learned from soreness/RPE responses (1 = default). */
  exerciseCostMultipliers: Record<string, number>;
  /** Weekly impact tolerance in impact units. */
  impactWeeklyToleranceIU: number;
  /** Mean daily session-RPE load over 28 days (AU), for the daily cap. */
  meanDailyLoadAU: number;
  /** Learned per-weekday box priors (0 = Monday). Absent when not learned. */
  boxPriorByWeekday?: Partial<Record<number, { credits: Record<string, number>; confidence: number }>>;
}

export interface Baseline {
  metric: string;
  /** 28-day median for RHR/sleep, mean for HRV (ln rMSSD) */
  center: number;
  /** Standard deviation when meaningful. */
  sd: number | null;
  sampleCount: number;
  windowDays: number;
}
