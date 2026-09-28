import {
  STIMULUS_KEY_VALUES,
  STIMULUS_WINDOW_DAYS,
  type StimulusCredits,
  type StimulusKey,
} from "../core";
import { addDays, daysBetween, isoWeekEnd, remainingDaysInWeek, type IsoDate } from "../core/dates";
import type { StimulusTargets } from "./targets";

export const LEDGER_ALGORITHM_VERSION = "exposure_ledger_v1" as const;

export interface CreditedSession {
  date: IsoDate;
  credits: StimulusCredits;
}

export interface LedgerEntry {
  key: StimulusKey;
  windowDays: number;
  target: number;
  /** Credits earned inside the trailing window (ending today, inclusive). */
  credits: number;
  /** Credits expected from fixed planned sessions between tomorrow and the end of the ISO week. */
  plannedFixedCredits: number;
  gap: number;
  /** Gap once fixed planned sessions are accounted for — what free days must still cover. */
  projectedGap: number;
  excess: number;
  /** Days since the last exposure ≥ 0.8 credit (null when never). */
  stalenessDays: number | null;
  /** clamp((gap/target) × 7/remainingDaysInWeek, 0.5, 1.5) — how pressing the gap is. */
  urgency: number;
}

export type Ledger = Record<StimulusKey, LedgerEntry>;

export interface ComputeLedgerInput {
  today: IsoDate;
  targets: StimulusTargets;
  /** Completed sessions with actual credits (any range; filtered by window). */
  history: readonly CreditedSession[];
  /** Fixed planned sessions (class, coaching) with expected credits, today excluded. */
  plannedFixed?: readonly CreditedSession[];
  /** Staleness lookback (days). */
  stalenessLookbackDays?: number;
}

export function computeLedger(input: ComputeLedgerInput): Ledger {
  const { today, targets, history } = input;
  const weekEnd = isoWeekEnd(today);
  const remaining = remainingDaysInWeek(today);
  const lookback = input.stalenessLookbackDays ?? 42;
  const out = {} as Ledger;

  for (const key of STIMULUS_KEY_VALUES) {
    const windowDays = STIMULUS_WINDOW_DAYS[key];
    const windowStart = addDays(today, -(windowDays - 1));
    let credits = 0;
    let lastBig: IsoDate | null = null;
    for (const s of history) {
      const c = s.credits[key] ?? 0;
      if (c <= 0) continue;
      if (s.date >= windowStart && s.date <= today) credits += c;
      if (c >= 0.8 && s.date <= today && daysBetween(s.date, today) <= lookback) {
        if (!lastBig || s.date > lastBig) lastBig = s.date;
      }
    }
    let plannedFixedCredits = 0;
    for (const s of input.plannedFixed ?? []) {
      if (s.date > today && s.date <= weekEnd) plannedFixedCredits += s.credits[key] ?? 0;
    }
    const target = targets[key];
    const gap = Math.max(0, target - credits);
    const projectedGap = Math.max(0, target - credits - plannedFixedCredits);
    const excess = Math.max(0, credits - target * 1.25);
    const urgency = target > 0 ? clamp((gap / target) * (7 / remaining), 0.5, 1.5) : 0.5;
    out[key] = {
      key,
      windowDays,
      target: round2(target),
      credits: round2(credits),
      plannedFixedCredits: round2(plannedFixedCredits),
      gap: round2(gap),
      projectedGap: round2(projectedGap),
      excess: round2(excess),
      stalenessDays: lastBig ? daysBetween(lastBig, today) : null,
      urgency: round2(urgency),
    };
  }
  return out;
}

/** Keys sorted by projected gap × urgency (largest first) — the "holes to fill". */
export function rankGaps(ledger: Ledger): LedgerEntry[] {
  return Object.values(ledger)
    .filter((e) => e.projectedGap > 0)
    .sort((a, b) => b.projectedGap * b.urgency - a.projectedGap * a.urgency);
}

/** Sum credits of many sessions. */
export function sumCredits(sessions: readonly CreditedSession[]): StimulusCredits {
  const out: StimulusCredits = {};
  for (const s of sessions) {
    for (const [k, v] of Object.entries(s.credits) as Array<[StimulusKey, number]>) {
      out[k] = (out[k] ?? 0) + v;
    }
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
