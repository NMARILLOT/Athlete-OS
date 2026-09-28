import type { Confidence, Modality } from "../core";

/**
 * Endurance metrics (spec §17). Every function is version-pinned, deterministic and tolerant of
 * missing data: when the inputs are insufficient it returns null — it never fills gaps in.
 */
export const PACE_AT_HR_ALGORITHM_VERSION = "pace_at_hr_v1" as const;
export const AEROBIC_DECOUPLING_ALGORITHM_VERSION = "aerobic_decoupling_v1" as const;
export const EFFICIENCY_FACTOR_ALGORITHM_VERSION = "efficiency_factor_v1" as const;
export const RUNNING_DYNAMICS_ALGORITHM_VERSION = "running_dynamics_summary_v1" as const;
export const THRESHOLD_ESTIMATE_ALGORITHM_VERSION = "threshold_estimate_v1" as const;

/** Below this speed the athlete is standing / walking at a light: excluded from pace statistics. */
export const MIN_MOVING_SPEED_MPS = 0.5;

const round = (x: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.round(x * f) / f;
};

const isPositive = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ---------------------------------------------------------------------------
// Pace @ HR
// ---------------------------------------------------------------------------

export interface PaceHrSample {
  hrBpm: number | null;
  speedMps: number | null;
}

export interface PaceAtHrResult {
  paceSecKm: number;
  avgHr: number;
  sampleCount: number;
  algorithmVersion: typeof PACE_AT_HR_ALGORITHM_VERSION;
}

/**
 * Mean pace over the samples whose HR sits inside [hrMin, hrMax] and that are moving (steady-state
 * estimate, e.g. "allure à 145–150 bpm"). Samples must be evenly spaced. Null under `minSamples`
 * (default 120 = 2 min at 1 Hz).
 */
export function paceAtHr(
  samples: readonly PaceHrSample[],
  hrMin: number,
  hrMax: number,
  options: { minSamples?: number } = {},
): PaceAtHrResult | null {
  const minSamples = options.minSamples ?? 120;
  const speeds: number[] = [];
  const hrs: number[] = [];
  for (const s of samples) {
    if (!isPositive(s.hrBpm) || !isPositive(s.speedMps)) continue;
    if (s.hrBpm < hrMin || s.hrBpm > hrMax || s.speedMps < MIN_MOVING_SPEED_MPS) continue;
    speeds.push(s.speedMps);
    hrs.push(s.hrBpm);
  }
  if (speeds.length < minSamples) return null;
  return {
    paceSecKm: Math.round(1000 / mean(speeds)),
    avgHr: round(mean(hrs), 1),
    sampleCount: speeds.length,
    algorithmVersion: PACE_AT_HR_ALGORITHM_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Aerobic decoupling
// ---------------------------------------------------------------------------

export interface DecouplingSample {
  tSec: number;
  hrBpm: number | null;
  speedMps?: number | null;
  powerW?: number | null;
}

export interface AerobicDecouplingResult {
  /** EF = output / HR, output in m/min (speed) or W (power). */
  firstHalfEf: number;
  secondHalfEf: number;
  /** (EF1 − EF2) / EF1 × 100 — positive = HR drifted up for the same output. */
  decouplingPct: number;
  basis: "speed" | "power";
  sampleCount: number;
  algorithmVersion: typeof AEROBIC_DECOUPLING_ALGORITHM_VERSION;
}

/** Fraction of samples that must carry power for the power basis to be chosen. */
const POWER_BASIS_MIN_SHARE = 0.8;
/** Each half needs at least this many valid samples. */
const DECOUPLING_MIN_HALF_SAMPLES = 60;

/**
 * Pw:Hr / Pa:Hr decoupling (spec §17): efficiency factor of the first half vs the second half of a
 * steady effort, after skipping the warm-up. Power is used when ≥ 80 % of samples carry it (bike),
 * speed otherwise. Null when the effort after warm-up is shorter than `minDurationSec` (default
 * 40 min) or a half has too few valid samples.
 */
export function aerobicDecoupling(
  samples: readonly DecouplingSample[],
  options: { warmupSkipSec?: number; minDurationSec?: number } = {},
): AerobicDecouplingResult | null {
  const warmupSkipSec = options.warmupSkipSec ?? 600;
  const minDurationSec = options.minDurationSec ?? 2400;
  const ordered = samples
    .filter((s) => Number.isFinite(s.tSec) && s.tSec >= warmupSkipSec)
    .sort((a, b) => a.tSec - b.tSec);
  if (ordered.length === 0) return null;
  const first = ordered[0] as DecouplingSample;
  const last = ordered[ordered.length - 1] as DecouplingSample;
  if (last.tSec - first.tSec < minDurationSec) return null;

  const withPower = ordered.filter((s) => isPositive(s.powerW)).length;
  const basis: "speed" | "power" =
    withPower / ordered.length >= POWER_BASIS_MIN_SHARE ? "power" : "speed";
  const output = (s: DecouplingSample): number | null =>
    basis === "power"
      ? isPositive(s.powerW)
        ? s.powerW
        : null
      : isPositive(s.speedMps)
        ? s.speedMps * 60
        : null;

  const midT = (first.tSec + last.tSec) / 2;
  const halves: { out: number[]; hr: number[] }[] = [
    { out: [], hr: [] },
    { out: [], hr: [] },
  ];
  for (const s of ordered) {
    const o = output(s);
    if (o == null || !isPositive(s.hrBpm)) continue;
    const half = halves[s.tSec < midT ? 0 : 1] as { out: number[]; hr: number[] };
    half.out.push(o);
    half.hr.push(s.hrBpm);
  }
  const [h1, h2] = halves as [{ out: number[]; hr: number[] }, { out: number[]; hr: number[] }];
  if (h1.out.length < DECOUPLING_MIN_HALF_SAMPLES || h2.out.length < DECOUPLING_MIN_HALF_SAMPLES)
    return null;

  const firstHalfEf = mean(h1.out) / mean(h1.hr);
  const secondHalfEf = mean(h2.out) / mean(h2.hr);
  return {
    firstHalfEf: round(firstHalfEf, 4),
    secondHalfEf: round(secondHalfEf, 4),
    decouplingPct: round(((firstHalfEf - secondHalfEf) / firstHalfEf) * 100, 2),
    basis,
    sampleCount: h1.out.length + h2.out.length,
    algorithmVersion: AEROBIC_DECOUPLING_ALGORITHM_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Efficiency factor
// ---------------------------------------------------------------------------

/** EF = average output / average HR (output in m/min for speed, W for power). Null when either is missing. */
export function efficiencyFactor(
  avgOutput: number | null | undefined,
  avgHr: number | null | undefined,
): number | null {
  if (!isPositive(avgOutput) || !isPositive(avgHr)) return null;
  return round(avgOutput / avgHr, 4);
}

export interface EfficiencyFactorResult {
  ef: number;
  basis: "speed" | "power";
  algorithmVersion: typeof EFFICIENCY_FACTOR_ALGORITHM_VERSION;
}

/** Bike with power → power/HR; otherwise speed (m/min)/HR. Null when the activity lacks HR or output. */
export function efficiencyFactorForActivity(activity: {
  modality: Modality;
  avgSpeedMps?: number | null;
  avgPowerW?: number | null;
  avgHr?: number | null;
}): EfficiencyFactorResult | null {
  if (activity.modality === "bike" && isPositive(activity.avgPowerW)) {
    const ef = efficiencyFactor(activity.avgPowerW, activity.avgHr);
    return ef == null
      ? null
      : { ef, basis: "power", algorithmVersion: EFFICIENCY_FACTOR_ALGORITHM_VERSION };
  }
  if (!isPositive(activity.avgSpeedMps)) return null;
  const ef = efficiencyFactor(activity.avgSpeedMps * 60, activity.avgHr);
  return ef == null
    ? null
    : { ef, basis: "speed", algorithmVersion: EFFICIENCY_FACTOR_ALGORITHM_VERSION };
}

// ---------------------------------------------------------------------------
// Running dynamics
// ---------------------------------------------------------------------------

export interface RunningDynamicsSample {
  cadence?: number | null;
  strideLengthM?: number | null;
  gctMs?: number | null;
  verticalOscillationMm?: number | null;
  verticalRatio?: number | null;
  gctBalance?: number | null;
}

export interface RunningDynamicsSummary {
  cadence?: number;
  strideLengthM?: number;
  gctMs?: number;
  verticalOscillationMm?: number;
  verticalRatio?: number;
  gctBalance?: number;
  sampleCount: number;
  algorithmVersion: typeof RUNNING_DYNAMICS_ALGORITHM_VERSION;
}

const DYNAMICS_FIELDS: ReadonlyArray<{ key: keyof RunningDynamicsSample; decimals: number }> = [
  { key: "cadence", decimals: 1 },
  { key: "strideLengthM", decimals: 2 },
  { key: "gctMs", decimals: 0 },
  { key: "verticalOscillationMm", decimals: 1 },
  { key: "verticalRatio", decimals: 1 },
  { key: "gctBalance", decimals: 1 },
];

/** A field must be present in at least this share of the samples to be summarised. */
export const DYNAMICS_MIN_COVERAGE = 0.5;

/**
 * Averages of the running-dynamics fields (HRM-Pro Plus, spec §15) present in ≥ 50 % of samples.
 * A field the sensor did not provide is simply absent from the result — never invented.
 */
export function runningDynamicsSummary(
  samples: readonly RunningDynamicsSample[],
): RunningDynamicsSummary | null {
  if (samples.length === 0) return null;
  const out: RunningDynamicsSummary = {
    sampleCount: samples.length,
    algorithmVersion: RUNNING_DYNAMICS_ALGORITHM_VERSION,
  };
  for (const { key, decimals } of DYNAMICS_FIELDS) {
    const values = samples.map((s) => s[key]).filter(isPositive);
    if (values.length / samples.length < DYNAMICS_MIN_COVERAGE) continue;
    out[key] = round(mean(values), decimals);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Threshold estimate from a standard test
// ---------------------------------------------------------------------------

export const THRESHOLD_TEST_KEY_VALUES = ["run_5k", "run_10k", "row_2k", "row_5k"] as const;
export type ThresholdTestKey = (typeof THRESHOLD_TEST_KEY_VALUES)[number];

export interface ThresholdEstimate {
  testKey: ThresholdTestKey;
  /** Running tests. */
  thresholdPaceSecKm?: number;
  /** Rowing tests (sec / 500 m). */
  thresholdPaceSec500m?: number;
  thresholdHr?: number;
  confidence: Confidence;
  source: "CALCULATED";
  algorithmVersion: typeof THRESHOLD_ESTIMATE_ALGORITHM_VERSION;
}

/**
 * Documented conversion factors: threshold pace ≈ test pace × paceFactor (slower), threshold HR ≈
 * test average HR × hrFactor. `minTimeSec` is a plausibility floor (faster than that is a typo).
 */
export const THRESHOLD_TEST_FACTORS: Record<
  ThresholdTestKey,
  {
    distanceM: number;
    paceFactor: number;
    hrFactor: number;
    minTimeSec: number;
    unit: "km" | "500m";
  }
> = {
  run_5k: { distanceM: 5000, paceFactor: 1.05, hrFactor: 0.99, minTimeSec: 12 * 60, unit: "km" },
  run_10k: { distanceM: 10_000, paceFactor: 1.02, hrFactor: 1.0, minTimeSec: 26 * 60, unit: "km" },
  row_2k: { distanceM: 2000, paceFactor: 1.07, hrFactor: 0.97, minTimeSec: 5 * 60, unit: "500m" },
  row_5k: { distanceM: 5000, paceFactor: 1.02, hrFactor: 1.0, minTimeSec: 14 * 60, unit: "500m" },
};

/**
 * Threshold pace/HR from a standardised test (spec §17/§57). MEDIUM confidence with an average HR,
 * LOW without one. Null for a missing or implausible time.
 */
export function thresholdEstimateFromTest(
  testKey: ThresholdTestKey,
  timeSec: number | null | undefined,
  avgHr?: number | null,
): ThresholdEstimate | null {
  const f = THRESHOLD_TEST_FACTORS[testKey];
  if (!isPositive(timeSec) || timeSec < f.minTimeSec) return null;
  const unitM = f.unit === "km" ? 1000 : 500;
  const testPace = timeSec / (f.distanceM / unitM);
  const thresholdPace = Math.round(testPace * f.paceFactor);
  const out: ThresholdEstimate = {
    testKey,
    confidence: "LOW",
    source: "CALCULATED",
    algorithmVersion: THRESHOLD_ESTIMATE_ALGORITHM_VERSION,
  };
  if (f.unit === "km") out.thresholdPaceSecKm = thresholdPace;
  else out.thresholdPaceSec500m = thresholdPace;
  if (isPositive(avgHr)) {
    out.thresholdHr = Math.round(avgHr * f.hrFactor);
    out.confidence = "MEDIUM";
  }
  return out;
}
