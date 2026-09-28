import { STIMULUS_KEY_VALUES, LOAD_DIMENSION_VALUES, type StimulusKey } from "../core";
import { stimulusWeight } from "../stimulus/affinity";
import type { Candidate, DerivedContext } from "./types";

/** All scoring constants in one place (ADR-014). Bounded terms; rule scores are fixed elsewhere. */
export const SCORING = {
  coverageCap: 15,
  coverageScale: 6,
  interferenceCap: 12,
  interferenceScale: 3,
  fatigueRatioCap: 1.5,
  recoveryFatigueStart: 0.6,
  recoveryFatigueSpan: 0.6,
  recoveryFatigueWeight: 10,
  recoveryReadiness: { poor: 5, ok: 2, good: 0, unknown: 1 } as const,
  recoveryStreakDays: 5,
  recoveryStreakBonus: 4,
  rule: {
    safety: -4,
    balance: 3,
    preference: 2,
    intentExact: 6,
    intentPartial: 3,
    varietyMin: -2,
    varietyMax: 1,
    adherence: 4,
    staleness: 2,
    stalenessLong: 3,
    recoveryDayVeto: 6,
    recoveryDayNudge: 4,
  } as const,
} as const;

export interface CoverageResult {
  coverage: number;
  coveredKeys: StimulusKey[];
}

export function coverage(ctx: DerivedContext, c: Candidate): CoverageResult {
  if (c.recovery) return { coverage: 0, coveredKeys: [] };
  let sum = 0;
  const covered: StimulusKey[] = [];
  for (const k of STIMULUS_KEY_VALUES) {
    const credit = c.expectedCredits[k] ?? 0;
    if (credit <= 0) continue;
    const entry = ctx.ledger[k];
    const gap = entry.projectedGap;
    if (gap <= 0) continue;
    const w = stimulusWeight(k, ctx.input.profile.goalWeights);
    sum += Math.min(credit, gap) * w * entry.urgency * SCORING.coverageScale;
    covered.push(k);
  }
  return { coverage: round2(Math.min(SCORING.coverageCap, sum)), coveredKeys: covered };
}

export function interference(ctx: DerivedContext, c: Candidate): number {
  let sum = 0;
  for (const dim of LOAD_DIMENSION_VALUES) {
    const ratio = Math.min(ctx.fatigueRatio[dim], SCORING.fatigueRatioCap);
    sum += (c.loadVector[dim] / 10) * ratio * SCORING.interferenceScale;
  }
  return round2(Math.min(SCORING.interferenceCap, sum));
}

export function recoveryTerm(ctx: DerivedContext, c: Candidate): number {
  if (!c.recovery) return 0;
  const fatiguePart =
    SCORING.recoveryFatigueWeight *
    clamp((ctx.maxFatigueRatio - SCORING.recoveryFatigueStart) / SCORING.recoveryFatigueSpan, 0, 1);
  const readinessPart = SCORING.recoveryReadiness[ctx.readinessBand];
  const streakPart =
    ctx.consecutiveTrainingDays >= SCORING.recoveryStreakDays ? SCORING.recoveryStreakBonus : 0;
  // Rest (doing nothing) should not beat an active recovery option when fatigue is moderate.
  const restPenalty =
    c.kind === "rest" && ctx.maxFatigueRatio < 0.8 && ctx.readinessBand !== "poor" ? -1 : 0;
  return round2(fatiguePart + readinessPart + streakPart + restPenalty);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
