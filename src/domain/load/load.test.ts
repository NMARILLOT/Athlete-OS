import { describe, expect, it } from "vitest";
import { emptyLoadVector } from "../core";
import {
  DEFAULT_HALF_LIVES,
  fatigueBand,
  residualFatigue,
  scaleLoadVector,
  windowSum,
} from "./fatigue";
import { dailyLoadSeries, summarizeLoad, trailingSum } from "./rolling";
import { intensityFromRpe, sessionRpeLoad } from "./session-rpe";

describe("session-RPE load", () => {
  it("multiplies minutes by RPE (spec §20 example)", () => {
    expect(sessionRpeLoad(60, 7)).toBe(420);
  });
  it("returns null without RPE", () => {
    expect(sessionRpeLoad(60, null)).toBeNull();
    expect(sessionRpeLoad(0, 7)).toBeNull();
  });
  it("bands intensity", () => {
    expect(intensityFromRpe(3)).toBe("easy");
    expect(intensityFromRpe(6)).toBe("moderate");
    expect(intensityFromRpe(8)).toBe("hard");
  });
});

describe("residual fatigue", () => {
  const heavyLegs = { ...emptyLoadVector(), muscular_lower: 8, eccentric: 6, cardiovascular: 3 };

  it("halves after one half-life", () => {
    const end = "2026-09-27T12:00:00Z";
    const now = `2026-09-28T${String(12 + DEFAULT_HALF_LIVES.muscular_lower - 24).padStart(2, "0")}:00:00Z`; // +36h
    const r = residualFatigue([{ endTime: end, loadVector: heavyLegs }], now);
    expect(r.muscular_lower).toBeCloseTo(4, 1);
  });

  it("ignores future sessions and sums multiple sessions", () => {
    const r = residualFatigue(
      [
        { endTime: "2026-09-28T08:00:00Z", loadVector: heavyLegs },
        { endTime: "2026-09-28T09:00:00Z", loadVector: heavyLegs },
        { endTime: "2026-09-29T09:00:00Z", loadVector: heavyLegs },
      ],
      "2026-09-28T09:00:00Z",
    );
    expect(r.muscular_lower).toBeGreaterThan(15);
    expect(r.muscular_lower).toBeLessThan(16.1);
  });

  it("bands values", () => {
    expect(fatigueBand(1)).toBe("low");
    expect(fatigueBand(4)).toBe("moderate");
    expect(fatigueBand(7)).toBe("high");
    expect(fatigueBand(9.5)).toBe("very_high");
  });

  it("scales vectors and sums windows", () => {
    expect(scaleLoadVector(heavyLegs, 0.5).muscular_lower).toBe(4);
    const s = windowSum(
      [
        { endTime: "2026-09-27T12:00:00Z", loadVector: { ...emptyLoadVector(), impact: 5 } },
        { endTime: "2026-09-18T12:00:00Z", loadVector: { ...emptyLoadVector(), impact: 5 } },
      ],
      "2026-09-28T12:00:00Z",
      7 * 24,
      "impact",
    );
    expect(s).toBe(5);
  });
});

describe("rolling load", () => {
  it("builds a dense series and sums trailing windows", () => {
    const series = dailyLoadSeries(
      [
        { date: "2026-09-01", load: 300 },
        { date: "2026-09-01", load: 100 },
        { date: "2026-09-10", load: 500 },
        { date: "2026-09-28", load: 420 },
      ],
      "2026-09-01",
      "2026-09-28",
    );
    expect(series).toHaveLength(28);
    expect(series[0]?.load).toBe(400);
    expect(trailingSum(series, 7)).toBe(420);
    const s = summarizeLoad(series);
    expect(s.acute7d).toBe(420);
    expect(s.chronic28d).toBe(1320);
    expect(s.ratio).not.toBeNull();
  });

  it("does not compute a ratio with too little history", () => {
    const series = dailyLoadSeries([{ date: "2026-09-28", load: 420 }], "2026-09-25", "2026-09-28");
    expect(summarizeLoad(series).ratio).toBeNull();
  });
});
