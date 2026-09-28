import type { Baseline } from "./types";

export const BASELINE_ALGORITHM_VERSION = "personal_baseline_v1" as const;

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function sd(values: number[]): number | null {
  if (values.length < 3) return null;
  const m = mean(values);
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1));
}

/**
 * Personal baseline (spec §40): "Is this unusual for Nicolas?" — not for an average human.
 * RHR / sleep use the median (robust to a bad night); HRV uses the mean of ln(rMSSD).
 */
export function computeBaseline(
  metric: string,
  samples: readonly number[],
  options: { windowDays?: number; minSamples?: number; useLog?: boolean; center?: "median" | "mean" } = {},
): Baseline | null {
  const minSamples = options.minSamples ?? 7;
  const values = samples.filter((v) => Number.isFinite(v)).map((v) => (options.useLog ? Math.log(v) : v));
  if (values.length < minSamples) return null;
  const center = (options.center ?? "median") === "median" ? median(values) : mean(values);
  return { metric, center, sd: sd(values), sampleCount: values.length, windowDays: options.windowDays ?? 28 };
}

export type Deviation = { direction: "above" | "below" | "normal"; delta: number; deltaPct: number; zScore: number | null };

export function deviationFrom(baseline: Baseline, value: number, useLog = false): Deviation {
  const v = useLog ? Math.log(value) : value;
  const delta = v - baseline.center;
  const deltaPct = baseline.center !== 0 ? (delta / Math.abs(baseline.center)) * 100 : 0;
  const zScore = baseline.sd && baseline.sd > 0 ? delta / baseline.sd : null;
  const direction = Math.abs(delta) < 1e-9 ? "normal" : delta > 0 ? "above" : "below";
  return { direction, delta, deltaPct, zScore };
}
