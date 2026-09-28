import { describe, expect, it } from "vitest";
import { emptyLoadVector } from "../core";
import { impactDimension, impactUnits } from "./impact";
import { classifyIntensity, isHeavyStrengthSession } from "./intensity";
import { scaleTemplateLoadToActual } from "./scaling";

describe("intensity classifier", () => {
  it("marks threshold/VO2/intervals/tests hard", () => {
    expect(classifyIntensity({ cardioKind: "threshold" }).band).toBe("hard");
    expect(classifyIntensity({ cardioKind: "test" }).band).toBe("hard");
  });
  it("uses HR zone minutes", () => {
    expect(classifyIntensity({ minutesInZones: { z1: 10, z2: 20, z3: 5, z4: 8, z5: 3 } }).band).toBe("hard");
    expect(classifyIntensity({ minutesInZones: { z1: 10, z2: 20, z3: 25, z4: 2, z5: 0 } }).band).toBe("moderate");
    expect(classifyIntensity({ minutesInZones: { z1: 10, z2: 50, z3: 5, z4: 0, z5: 0 } }).band).toBe("easy");
  });
  it("treats short high-rate metcons as hard and long metcons as moderate", () => {
    expect(classifyIntensity({ metcon: { timeDomainMin: 12, highRate: true } }).band).toBe("hard");
    expect(classifyIntensity({ metcon: { timeDomainMin: 35, highRate: true }, loadVector: { ...emptyLoadVector(), cardiovascular: 5 } }).band).toBe("moderate");
  });
  it("does not count heavy strength as metabolically hard", () => {
    expect(classifyIntensity({ heavyStrength: true, rpe: 9, loadVector: { ...emptyLoadVector(), cardiovascular: 2 } }).band).toBe("moderate");
    expect(isHeavyStrengthSession([{ rpe: 7 }, { rpe: 8.5 }])).toBe(true);
    expect(isHeavyStrengthSession([{ rpe: 7 }, { quality: "perfect" }])).toBe(false);
  });
});

describe("impact units", () => {
  it("converts counts per spec §47 conventions", () => {
    expect(impactUnits({ runKm: 5 })).toBe(5);
    expect(impactUnits({ doubleUnders: 200, boxJumps: 30, burpees: 30 })).toBe(3);
    expect(impactDimension(10)).toBe(10);
    expect(impactDimension(2)).toBe(2.4);
  });
});

describe("actual scaling", () => {
  it("scales by RPE and duration with clamps", () => {
    const t = { ...emptyLoadVector(), cardiovascular: 4, muscular_lower: 4 };
    const r = scaleTemplateLoadToActual(t, { rpe: 9, expectedRpe: 4, actualMin: 90, plannedMin: 60 });
    expect(r.factor).toBeCloseTo(1.4 * Math.sqrt(1.5), 2);
    expect(r.estimated).toBe(false);
    const missing = scaleTemplateLoadToActual(t, { actualMin: 60, plannedMin: 60 });
    expect(missing.factor).toBe(1);
    expect(missing.estimated).toBe(true);
  });
});
