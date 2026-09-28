/**
 * Session-RPE load (Foster): duration (min) × RPE (1..10) → arbitrary units (AU).
 * Spec §20: complementary to discipline-specific metrics, never the sole load measure.
 */
export const SESSION_RPE_ALGORITHM_VERSION = "session_rpe_v1" as const;

export function sessionRpeLoad(durationMin: number, rpe: number | null | undefined): number | null {
  if (rpe == null || !Number.isFinite(rpe) || rpe < 1 || rpe > 10) return null;
  if (!Number.isFinite(durationMin) || durationMin <= 0) return null;
  return Math.round(durationMin * rpe);
}

/** Intensity band from RPE (used when a session has no explicit band). */
export function intensityFromRpe(
  rpe: number | null | undefined,
): "easy" | "moderate" | "hard" | null {
  if (rpe == null) return null;
  if (rpe <= 4.5) return "easy";
  if (rpe <= 6.5) return "moderate";
  return "hard";
}
