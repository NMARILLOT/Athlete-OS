import {
  LOAD_DIMENSION_VALUES,
  emptyLoadVector,
  type LoadDimension,
  type LoadVector,
} from "../core";
import { hoursBetween } from "../core/dates";

/**
 * Residual fatigue per dimension by exponential decay (ADR-005):
 *   residual[dim] = Σ_sessions load[dim] × 0.5 ^ (hoursSince / halfLife[dim])
 *
 * Half-lives are athlete-model parameters. Defaults are conservative sports-science priors,
 * not measurements; the athlete model may learn per-dimension adjustments over time.
 */
export const FATIGUE_ALGORITHM_VERSION = "residual_fatigue_v1" as const;

export type HalfLives = Record<LoadDimension, number>;

/** Hours. */
export const DEFAULT_HALF_LIVES: HalfLives = {
  cardiovascular: 20,
  muscular_lower: 36,
  muscular_upper: 30,
  impact: 36,
  eccentric: 48,
  technical: 12,
};

export interface LoadedSession {
  /** ISO datetime when the session ended (or started + duration). */
  endTime: string;
  loadVector: LoadVector;
}

export function residualFatigue(
  sessions: readonly LoadedSession[],
  now: string,
  halfLives: HalfLives = DEFAULT_HALF_LIVES,
): LoadVector {
  const out = emptyLoadVector();
  for (const s of sessions) {
    const hours = hoursBetween(s.endTime, now);
    if (hours < 0) continue; // future sessions do not create fatigue
    for (const dim of LOAD_DIMENSION_VALUES) {
      const hl = halfLives[dim];
      const factor = Math.pow(0.5, hours / hl);
      out[dim] += s.loadVector[dim] * factor;
    }
  }
  for (const dim of LOAD_DIMENSION_VALUES) out[dim] = Math.round(out[dim] * 100) / 100;
  return out;
}

/**
 * Qualitative band per dimension. Thresholds are on the same 0..10-per-session scale:
 *  - a single maximal session leaves ~10 immediately, ~5 after one half-life.
 */
export type FatigueBand = "low" | "moderate" | "high" | "very_high";

export function fatigueBand(value: number): FatigueBand {
  if (value >= 9) return "very_high";
  if (value >= 6) return "high";
  if (value >= 3) return "moderate";
  return "low";
}

export function fatigueBands(v: LoadVector): Record<LoadDimension, FatigueBand> {
  return {
    cardiovascular: fatigueBand(v.cardiovascular),
    muscular_lower: fatigueBand(v.muscular_lower),
    muscular_upper: fatigueBand(v.muscular_upper),
    impact: fatigueBand(v.impact),
    eccentric: fatigueBand(v.eccentric),
    technical: fatigueBand(v.technical),
  };
}

export function scaleLoadVector(v: LoadVector, factor: number): LoadVector {
  const out = emptyLoadVector();
  for (const dim of LOAD_DIMENSION_VALUES) out[dim] = Math.round(v[dim] * factor * 100) / 100;
  return out;
}

/** Sum of a dimension over sessions inside a trailing window (no decay) — used for budgets (impact 7d). */
export function windowSum(
  sessions: readonly LoadedSession[],
  now: string,
  windowHours: number,
  dim: LoadDimension,
): number {
  let total = 0;
  for (const s of sessions) {
    const h = hoursBetween(s.endTime, now);
    if (h >= 0 && h <= windowHours) total += s.loadVector[dim];
  }
  return Math.round(total * 100) / 100;
}
