import { describe, expect, it } from "vitest";
import {
  AEROBIC_DECOUPLING_ALGORITHM_VERSION,
  PACE_AT_HR_ALGORITHM_VERSION,
  THRESHOLD_ESTIMATE_ALGORITHM_VERSION,
  aerobicDecoupling,
  efficiencyFactor,
  efficiencyFactorForActivity,
  paceAtHr,
  runningDynamicsSummary,
  thresholdEstimateFromTest,
  type DecouplingSample,
} from "./metrics";

const repeat = <T>(n: number, make: (i: number) => T): T[] =>
  Array.from({ length: n }, (_, i) => make(i));

describe("pace @ HR", () => {
  it("averages pace over moving samples inside the HR band", () => {
    const samples = [
      ...repeat(300, () => ({ hrBpm: 147, speedMps: 3 })),
      ...repeat(50, () => ({ hrBpm: 160, speedMps: 3.5 })), // outside the band
      ...repeat(20, () => ({ hrBpm: 146, speedMps: 0.2 })), // standing at a light
      ...repeat(10, () => ({ hrBpm: null, speedMps: 3 })),
    ];
    const r = paceAtHr(samples, 145, 150);
    expect(r).toEqual({
      paceSecKm: 333,
      avgHr: 147,
      sampleCount: 300,
      algorithmVersion: PACE_AT_HR_ALGORITHM_VERSION,
    });
  });

  it("returns null under the minimum sample count instead of guessing", () => {
    const samples = repeat(100, () => ({ hrBpm: 147, speedMps: 3 }));
    expect(paceAtHr(samples, 145, 150)).toBeNull();
    expect(paceAtHr(samples, 145, 150, { minSamples: 60 })?.sampleCount).toBe(100);
  });
});

describe("aerobic decoupling", () => {
  const steadyRun = (secondHalfHr: number): DecouplingSample[] =>
    repeat(3600, (t) => ({ tSec: t, hrBpm: t < 2100 ? 145 : secondHalfHr, speedMps: 3 }));

  it("measures HR drift at constant speed after skipping the warm-up", () => {
    const r = aerobicDecoupling(steadyRun(152));
    expect(r?.basis).toBe("speed");
    expect(r?.firstHalfEf).toBeCloseTo(180 / 145, 3);
    expect(r?.secondHalfEf).toBeCloseTo(180 / 152, 3);
    expect(r?.decouplingPct).toBeCloseTo(4.61, 2);
    expect(r?.sampleCount).toBe(3000);
    expect(r?.algorithmVersion).toBe(AEROBIC_DECOUPLING_ALGORITHM_VERSION);
    expect(aerobicDecoupling(steadyRun(145))?.decouplingPct).toBe(0);
  });

  it("returns null for short efforts and uses power on the bike", () => {
    expect(aerobicDecoupling(steadyRun(152).slice(0, 2400))).toBeNull();
    expect(
      aerobicDecoupling(steadyRun(152), { minDurationSec: 1200, warmupSkipSec: 1500 }),
    ).not.toBeNull();
    const ride = repeat(4000, (t) => ({
      tSec: t,
      hrBpm: t < 2300 ? 140 : 146,
      powerW: 200,
      speedMps: 8,
    }));
    const r = aerobicDecoupling(ride);
    expect(r?.basis).toBe("power");
    expect(r?.firstHalfEf).toBeCloseTo(200 / 140, 3);
    expect(r?.decouplingPct).toBeCloseTo((1 - 140 / 146) * 100, 2);
  });
});

describe("efficiency factor", () => {
  it("is output / HR and prefers power on the bike", () => {
    expect(efficiencyFactor(180, 150)).toBe(1.2);
    expect(efficiencyFactor(180, null)).toBeNull();
    expect(efficiencyFactor(0, 150)).toBeNull();
    expect(
      efficiencyFactorForActivity({ modality: "bike", avgPowerW: 210, avgSpeedMps: 8, avgHr: 140 }),
    ).toMatchObject({ ef: 1.5, basis: "power" });
    expect(
      efficiencyFactorForActivity({ modality: "bike", avgSpeedMps: 8, avgHr: 140 }),
    ).toMatchObject({ ef: 3.4286, basis: "speed" });
    expect(
      efficiencyFactorForActivity({ modality: "running", avgSpeedMps: 3, avgHr: 150 }),
    ).toMatchObject({ ef: 1.2, basis: "speed" });
    expect(
      efficiencyFactorForActivity({ modality: "running", avgSpeedMps: 3, avgHr: null }),
    ).toBeNull();
    expect(efficiencyFactorForActivity({ modality: "running", avgHr: 150 })).toBeNull();
  });
});

describe("running dynamics summary (spec §15)", () => {
  it("only reports fields present in at least half of the samples", () => {
    const samples = [
      ...repeat(80, () => ({ cadence: 172, gctMs: 250, strideLengthM: 1.1 })),
      ...repeat(20, () => ({
        cadence: 176,
        gctMs: null,
        strideLengthM: 1.2,
        verticalOscillationMm: 8,
      })),
    ];
    const s = runningDynamicsSummary(samples);
    expect(s).toEqual({
      cadence: 172.8,
      gctMs: 250,
      strideLengthM: 1.12,
      sampleCount: 100,
      algorithmVersion: "running_dynamics_summary_v1",
    });
    expect(s).not.toHaveProperty("verticalOscillationMm");
    expect(runningDynamicsSummary([])).toBeNull();
  });
});

describe("threshold estimate from a test (spec §17/§57)", () => {
  it("converts a 5 km with HR to threshold pace/HR at MEDIUM confidence", () => {
    // 22:30 → 270 s/km × 1.05 = 283.5 → 284; HR 178 × 0.99 → 176
    expect(thresholdEstimateFromTest("run_5k", 1350, 178)).toEqual({
      testKey: "run_5k",
      thresholdPaceSecKm: 284,
      thresholdHr: 176,
      confidence: "MEDIUM",
      source: "CALCULATED",
      algorithmVersion: THRESHOLD_ESTIMATE_ALGORITHM_VERSION,
    });
    expect(thresholdEstimateFromTest("run_10k", 2700)).toMatchObject({
      thresholdPaceSecKm: 275,
      confidence: "LOW",
    });
  });

  it("handles rowing splits and refuses implausible times", () => {
    // 7:20 → 110 s/500 m × 1.07 = 117.7 → 118
    const row = thresholdEstimateFromTest("row_2k", 440, 180);
    expect(row).toMatchObject({
      thresholdPaceSec500m: 118,
      thresholdHr: 175,
      confidence: "MEDIUM",
    });
    expect(row).not.toHaveProperty("thresholdPaceSecKm");
    expect(thresholdEstimateFromTest("row_5k", 1200)).toMatchObject({
      thresholdPaceSec500m: 122,
      confidence: "LOW",
    });
    expect(thresholdEstimateFromTest("run_5k", 500)).toBeNull();
    expect(thresholdEstimateFromTest("run_5k", null)).toBeNull();
  });
});
