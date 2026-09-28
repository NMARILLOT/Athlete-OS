import { addDays, daysBetween, type IsoDate } from "../core/dates";

export interface DailyLoadPoint {
  date: IsoDate;
  load: number;
}

/** Aggregate per-session loads into a dense daily series (zeros for empty days). */
export function dailyLoadSeries(
  sessions: ReadonlyArray<{ date: IsoDate; load: number | null }>,
  from: IsoDate,
  to: IsoDate,
): DailyLoadPoint[] {
  const map = new Map<IsoDate, number>();
  for (const s of sessions) {
    if (s.load == null) continue;
    if (s.date < from || s.date > to) continue;
    map.set(s.date, (map.get(s.date) ?? 0) + s.load);
  }
  const out: DailyLoadPoint[] = [];
  const n = daysBetween(from, to);
  for (let i = 0; i <= n; i++) {
    const d = addDays(from, i);
    out.push({ date: d, load: map.get(d) ?? 0 });
  }
  return out;
}

/** Trailing sum over the last `windowDays` ending at the last point (inclusive). */
export function trailingSum(series: readonly DailyLoadPoint[], windowDays: number): number {
  const slice = series.slice(Math.max(0, series.length - windowDays));
  return slice.reduce((a, p) => a + p.load, 0);
}

export interface LoadSummary {
  /** Sum of the last 7 days. */
  acute7d: number;
  /** Sum of the last 28 days. */
  chronic28d: number;
  /** Average weekly load over the last 28 days. */
  chronicWeeklyAvg: number;
  /**
   * acute7d / chronicWeeklyAvg. Spec §20: shown as context, never presented as an injury predictor
   * and never the sole basis for a decision.
   */
  ratio: number | null;
  trend7dVsPrev7d: number | null;
}

export const LOAD_SUMMARY_ALGORITHM_VERSION = "load_summary_v1" as const;

export function summarizeLoad(series: readonly DailyLoadPoint[]): LoadSummary {
  const acute7d = trailingSum(series, 7);
  const chronic28d = trailingSum(series, 28);
  const daysAvailable = Math.min(28, series.length);
  const chronicWeeklyAvg = daysAvailable > 0 ? (chronic28d / daysAvailable) * 7 : 0;
  const prev7 = series.slice(Math.max(0, series.length - 14), Math.max(0, series.length - 7));
  const prev7Sum = prev7.reduce((a, p) => a + p.load, 0);
  return {
    acute7d,
    chronic28d,
    chronicWeeklyAvg: Math.round(chronicWeeklyAvg),
    ratio: chronicWeeklyAvg > 0 && daysAvailable >= 14 ? Math.round((acute7d / chronicWeeklyAvg) * 100) / 100 : null,
    trend7dVsPrev7d: prev7.length === 7 && prev7Sum > 0 ? Math.round(((acute7d - prev7Sum) / prev7Sum) * 100) / 100 : null,
  };
}

/** Simple rolling mean; returns null when fewer than `min` points. */
export function rollingMean(values: readonly number[], min = 3): number | null {
  if (values.length < min) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function stdDev(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(v);
}
