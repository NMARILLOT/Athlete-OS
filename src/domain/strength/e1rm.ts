/**
 * Estimated 1RM — Epley, version-pinned (ADR-007).
 *   e1RM = w × (1 + reps / 30)
 * Not computed for reps > 12 (formula drifts) nor for reps < 1. Result rounded to 0.5 kg.
 */
export const E1RM_ALGORITHM_VERSION = "e1rm_epley_v1" as const;

export const E1RM_MAX_REPS = 12;

export function estimateOneRepMax(weightKg: number, reps: number): number | null {
  if (!Number.isFinite(weightKg) || weightKg <= 0) return null;
  if (!Number.isInteger(reps) || reps < 1 || reps > E1RM_MAX_REPS) return null;
  if (reps === 1) return roundHalf(weightKg);
  return roundHalf(weightKg * (1 + reps / 30));
}

/** Inverse Epley: the weight that would yield `reps` at (or near) failure for a given e1RM. */
export function weightForReps(e1rmKg: number, reps: number): number {
  if (reps <= 1) return e1rmKg;
  return e1rmKg / (1 + reps / 30);
}

/**
 * Weight for a target reps × RPE pair. RPE r means (10 − r) reps in reserve, so the set is
 * equivalent to `reps + (10 − rpe)` reps at failure.
 */
export function weightForRepsAtRpe(e1rmKg: number, reps: number, rpe: number): number {
  const rir = Math.max(0, 10 - rpe);
  return weightForReps(e1rmKg, reps + rir);
}

/** Confidence of an e1RM estimate given the set it came from. */
export function e1rmConfidence(reps: number, rpe?: number | null): "HIGH" | "MEDIUM" | "LOW" {
  if (reps > E1RM_MAX_REPS) return "LOW";
  const nearFailure = rpe == null ? reps <= 5 : rpe >= 8;
  if (reps <= 5 && nearFailure) return "HIGH";
  if (reps <= 8) return "MEDIUM";
  return "LOW";
}

/** Best e1RM across a list of sets, ignoring warm-ups and sets outside the formula's range. */
export function bestE1rm(
  sets: ReadonlyArray<{ weightKg: number; reps: number; isWarmup?: boolean; rpe?: number | null }>,
): {
  e1rmKg: number;
  reps: number;
  weightKg: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
} | null {
  let best: ReturnType<typeof bestE1rm> = null;
  for (const s of sets) {
    if (s.isWarmup) continue;
    const e = estimateOneRepMax(s.weightKg, s.reps);
    if (e == null) continue;
    if (!best || e > best.e1rmKg) {
      best = {
        e1rmKg: e,
        reps: s.reps,
        weightKg: s.weightKg,
        confidence: e1rmConfidence(s.reps, s.rpe),
      };
    }
  }
  return best;
}

export function roundHalf(x: number): number {
  return Math.round(x * 2) / 2;
}

/** Round to the nearest available plate increment (e.g. 2.5 kg for a barbell). */
export function roundToIncrement(weightKg: number, incrementKg: number): number {
  if (incrementKg <= 0) return roundHalf(weightKg);
  return Math.round(weightKg / incrementKg) * incrementKg;
}
