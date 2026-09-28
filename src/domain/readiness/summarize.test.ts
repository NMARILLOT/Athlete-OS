import { describe, expect, it } from "vitest";
import { READINESS_ALGORITHM_VERSION, summarizeReadiness } from "./summarize";
import {
  ReadinessSummarySchema,
  type ReadinessBaselines,
  type ReadinessDeclared,
  type ReadinessMeasured,
} from "./types";

const computedAt = "2026-09-28T06:30:00+02:00";
const fine: ReadinessDeclared = { energy: 2, soreness: 1, motivation: 2, unusualPain: false };
const baselines: ReadinessBaselines = {
  restingHr: { metric: "resting_hr", center: 50, sd: 2, sampleCount: 28, windowDays: 28 },
  hrvLnRmssd: {
    metric: "hrv_rmssd",
    center: Math.log(60),
    sd: 0.2,
    sampleCount: 28,
    windowDays: 28,
  },
  sleepHours: { metric: "sleep_hours", center: 7.5, sd: 0.6, sampleCount: 28, windowDays: 28 },
};
const normal: ReadinessMeasured = { sleepHours: 7.4, restingHr: 51, hrvRmssd: 62, bodyBattery: 80 };

const worseKeys = (s: ReturnType<typeof summarizeReadiness>) =>
  s.signals.filter((x) => x.direction === "worse").map((x) => x.key);

describe("readiness summary (spec §21, ENGINE.md §2)", () => {
  it("is version pinned, never reads the clock, and is ok when nothing is known", () => {
    const s = summarizeReadiness({ computedAt });
    expect(s.algorithmVersion).toBe(READINESS_ALGORITHM_VERSION);
    expect(s.computedAt).toBe(computedAt);
    expect(s.band).toBe("ok");
    expect(s.hasDeclared).toBe(false);
    expect(s.hasMeasured).toBe(false);
    expect(s.notes).toContain("Aucune donnée de readiness : état inconnu.");
    expect(ReadinessSummarySchema.safeParse(s).success).toBe(true);
  });

  it("is good with normal measurements and a fine morning check-in", () => {
    const s = summarizeReadiness({ declared: fine, measured: normal, baselines, computedAt });
    expect(s.band).toBe("good");
    expect(s.signals).toEqual([]);
    expect(s.declaredCount).toBe(0);
    expect(s.measuredCount).toBe(0);
    expect(summarizeReadiness({ measured: normal, baselines, computedAt }).band).toBe("good");
    expect(summarizeReadiness({ declared: fine, computedAt }).band).toBe("good");
  });

  it("never yields poor on a single noisy measured metric (spec §91)", () => {
    const s = summarizeReadiness({
      declared: fine,
      measured: { ...normal, restingHr: 56 },
      baselines,
      computedAt,
    });
    expect(worseKeys(s)).toEqual(["rhr_high"]);
    expect(s.signals[0]?.source).toBe("CALCULATED");
    expect(s.band).toBe("ok");
    expect(s.notes).toContain("Un seul signal mesuré : pas de conclusion.");
    expect(
      summarizeReadiness({ measured: { ...normal, bodyBattery: 20 }, baselines, computedAt }).band,
    ).toBe("ok");
  });

  it("is poor with two measured signals", () => {
    const s = summarizeReadiness({
      measured: { ...normal, restingHr: 55, sleepHours: 5.5 },
      baselines,
      computedAt,
    });
    expect(worseKeys(s)).toEqual(["rhr_high", "sleep_short"]);
    expect(s.measuredCount).toBe(2);
    expect(s.band).toBe("poor");
    expect(s.notes).toContain("Readiness basse : 2 signaux.");
  });

  it("needs a second signal next to a declared one", () => {
    const tired: ReadinessDeclared = { ...fine, energy: 1 };
    expect(
      summarizeReadiness({ declared: tired, measured: normal, baselines, computedAt }).band,
    ).toBe("ok");
    expect(summarizeReadiness({ declared: { ...tired, soreness: 2 }, computedAt }).band).toBe(
      "poor",
    );
    const mixed = summarizeReadiness({
      declared: tired,
      measured: { ...normal, bodyBattery: 30 },
      baselines,
      computedAt,
    });
    expect(mixed.declaredCount).toBe(1);
    expect(mixed.measuredCount).toBe(1);
    expect(mixed.band).toBe("poor");
    expect(mixed.signals.map((x) => x.source)).toEqual(["USER", "GARMIN"]);
  });

  it("fires each declared signal from the documented thresholds", () => {
    const s = summarizeReadiness({
      declared: { energy: 1, soreness: 3, motivation: 1, unusualPain: true },
      computedAt,
    });
    expect(worseKeys(s)).toEqual(["energy_low", "soreness_high", "motivation_low", "unusual_pain"]);
    expect(s.declaredCount).toBe(4);
    expect(s.band).toBe("poor");
    const painOnly = summarizeReadiness({ declared: { ...fine, unusualPain: true }, computedAt });
    expect(painOnly.band).toBe("ok");
    expect(painOnly.notes).toContain("Un seul signal déclaré : à surveiller.");
  });

  it("compares HRV in log space against mean ± 0.5 SD, or −10 % without an SD", () => {
    const low = summarizeReadiness({ measured: { hrvRmssd: 52 }, baselines, computedAt }); // ln(52/60) = −0.143 < −0.1
    expect(worseKeys(low)).toEqual(["hrv_low"]);
    const high = summarizeReadiness({ measured: { hrvRmssd: 70 }, baselines, computedAt }); // +0.154 > +0.1
    expect(high.signals).toEqual([
      {
        key: "hrv_high",
        direction: "better",
        detail: "HRV 70 ms au-dessus de la baseline (60 ms)",
        source: "CALCULATED",
      },
    ]);
    expect(high.band).toBe("good");
    const noSd: ReadinessBaselines = {
      hrvLnRmssd: {
        metric: "hrv_rmssd",
        center: Math.log(60),
        sd: null,
        sampleCount: 7,
        windowDays: 28,
      },
    };
    expect(
      worseKeys(summarizeReadiness({ measured: { hrvRmssd: 55 }, baselines: noSd, computedAt })),
    ).toEqual([]);
    expect(
      worseKeys(summarizeReadiness({ measured: { hrvRmssd: 53 }, baselines: noSd, computedAt })),
    ).toEqual(["hrv_low"]);
  });

  it("uses the personal sleep baseline both ways and never interprets RHR without one", () => {
    const short = summarizeReadiness({ measured: { sleepHours: 5.9 }, baselines, computedAt });
    expect(short.signals[0]).toMatchObject({ key: "sleep_short", source: "GARMIN" });
    const belowMedian = summarizeReadiness({
      measured: { sleepHours: 6.1 },
      baselines: {
        sleepHours: { metric: "sleep_hours", center: 8, sd: 0.5, sampleCount: 20, windowDays: 28 },
      },
      computedAt,
    });
    expect(belowMedian.signals[0]).toMatchObject({ key: "sleep_short", source: "CALCULATED" });
    const long = summarizeReadiness({ measured: { sleepHours: 8.6 }, baselines, computedAt });
    expect(long.signals).toEqual([
      {
        key: "sleep_long",
        direction: "better",
        detail: "Sommeil 8.6 h (médiane 7.5 h)",
        source: "CALCULATED",
      },
    ]);
    const noBaseline = summarizeReadiness({ measured: { restingHr: 70 }, computedAt });
    expect(noBaseline.signals).toEqual([]);
    expect(noBaseline.notes).toContain("Pas de baseline FC repos : valeur non interprétée.");
  });

  it("is deterministic and persists through the JSONB schema", () => {
    const input = {
      declared: fine,
      measured: { ...normal, restingHr: 56, sleepHours: 5 },
      baselines,
      computedAt,
    };
    const a = summarizeReadiness(input);
    expect(a).toEqual(summarizeReadiness(input));
    expect(ReadinessSummarySchema.parse(JSON.parse(JSON.stringify(a)))).toEqual(a);
  });
});
