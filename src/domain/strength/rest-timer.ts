import type { SetIntent } from "./types";

export interface RestPolicy {
  defaultSec: number;
  minSec: number;
  maxSec: number;
}

/** Spec §78: heavy strength 2:30–5:00, hypertrophy 1:00–2:30, circuit per prescription. */
export const REST_POLICY: Record<SetIntent, RestPolicy> = {
  strength: { defaultSec: 180, minSec: 150, maxSec: 300 },
  power: { defaultSec: 150, minSec: 120, maxSec: 240 },
  hypertrophy: { defaultSec: 90, minSec: 60, maxSec: 150 },
  skill: { defaultSec: 90, minSec: 60, maxSec: 180 },
  circuit: { defaultSec: 45, minSec: 0, maxSec: 90 },
};

export function restSecondsFor(intent: SetIntent, overrideSec?: number | null): number {
  if (typeof overrideSec === "number" && overrideSec > 0) return overrideSec;
  return REST_POLICY[intent].defaultSec;
}

/** Longer rest after a hard/failed set, never above the policy max. */
export function adjustRestForQuality(baseSec: number, intent: SetIntent, quality?: "easy" | "perfect" | "hard" | "failed" | null): number {
  const p = REST_POLICY[intent];
  if (quality === "hard") return Math.min(p.maxSec, Math.round(baseSec * 1.2));
  if (quality === "failed") return Math.min(p.maxSec, Math.round(baseSec * 1.4));
  if (quality === "easy") return Math.max(p.minSec, Math.round(baseSec * 0.85));
  return baseSec;
}
