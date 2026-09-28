import { z } from "zod";
import type { Baseline } from "../athlete-model/types";
import type { IsoDateTime } from "../core/dates";

/**
 * Readiness (spec §21): at most three declared answers each morning + what Garmin measured
 * overnight, turned into explainable signals and a band. The band never decides alone (§21) and
 * a single noisy metric never yields "poor" (§91).
 */

export const READINESS_BAND_VALUES = ["good", "ok", "poor"] as const;
export type ReadinessBand = (typeof READINESS_BAND_VALUES)[number];

/** Morning answers: 😫😐😃 energy (1..3), soreness 0..3, 😫😐😃 motivation (1..3), unusual pain. */
export interface ReadinessDeclared {
  energy: 1 | 2 | 3;
  soreness: 0 | 1 | 2 | 3;
  motivation: 1 | 2 | 3;
  unusualPain: boolean;
}

/** Overnight measurements (recovery_metrics rows); every field optional — absent means not measured. */
export interface ReadinessMeasured {
  sleepHours?: number | null;
  sleepScore?: number | null;
  restingHr?: number | null;
  /** rMSSD in ms (raw). Compared to the ln(rMSSD) baseline. */
  hrvRmssd?: number | null;
  stress?: number | null;
  bodyBattery?: number | null;
}

/** Personal baselines (spec §40). `hrvLnRmssd.center` is the mean of ln(rMSSD), `sd` its SD. */
export interface ReadinessBaselines {
  restingHr?: Baseline | null;
  hrvLnRmssd?: Baseline | null;
  sleepHours?: Baseline | null;
}

export const READINESS_SIGNAL_SOURCE_VALUES = ["USER", "GARMIN", "CALCULATED"] as const;
export type ReadinessSignalSource = (typeof READINESS_SIGNAL_SOURCE_VALUES)[number];

export const ReadinessSignalSchema = z
  .object({
    key: z.string().min(1).max(60),
    direction: z.enum(["worse", "better"]),
    detail: z.string().max(200),
    source: z.enum(READINESS_SIGNAL_SOURCE_VALUES),
  })
  .strict();
export type ReadinessSignal = z.infer<typeof ReadinessSignalSchema>;

/** Persisted as `daily_readiness.summary` JSONB. */
export const ReadinessSummarySchema = z
  .object({
    algorithmVersion: z.string().min(1),
    computedAt: z.string().min(1),
    band: z.enum(READINESS_BAND_VALUES),
    signals: z.array(ReadinessSignalSchema),
    /** Number of "worse" signals from declared answers. */
    declaredCount: z.number().int().nonnegative(),
    /** Number of "worse" signals from measured data (raw thresholds or baseline deviations). */
    measuredCount: z.number().int().nonnegative(),
    hasDeclared: z.boolean(),
    hasMeasured: z.boolean(),
    notes: z.array(z.string()),
  })
  .strict();

export interface ReadinessSummary {
  algorithmVersion: string;
  computedAt: IsoDateTime;
  band: ReadinessBand;
  signals: ReadinessSignal[];
  declaredCount: number;
  measuredCount: number;
  hasDeclared: boolean;
  hasMeasured: boolean;
  notes: string[];
}
