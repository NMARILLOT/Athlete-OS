import { describe, expect, it } from "vitest";
import {
  HR_ZONES_ALGORITHM_VERSION,
  HR_ZONE_CEILING_BPM,
  HrZoneSetSchema,
  selectZoneSet,
  timeInZones,
  zoneForHr,
  zonesFromHrr,
  zonesFromLthr,
} from "./zones";

describe("HR zones (spec §16)", () => {
  it("is version pinned", () => {
    expect(HR_ZONES_ALGORITHM_VERSION).toBe("hr_zones_v1");
  });

  it("derives Friel-style zones from LTHR 170 (85/90/95/100 %)", () => {
    const set = zonesFromLthr(170, "2026-02-01", "GARMIN");
    expect(set.method).toBe("lthr");
    expect(set.confidence).toBe("HIGH");
    expect(set.zones).toEqual([
      { zone: 1, minBpm: 0, maxBpm: 144 },
      { zone: 2, minBpm: 145, maxBpm: 152 },
      { zone: 3, minBpm: 153, maxBpm: 161 },
      { zone: 4, minBpm: 162, maxBpm: 169 },
      { zone: 5, minBpm: 170, maxBpm: HR_ZONE_CEILING_BPM },
    ]);
    expect(HrZoneSetSchema.safeParse(set).success).toBe(true);
  });

  it("derives Karvonen zones from max 190 / resting 50 (HRR 140)", () => {
    const set = zonesFromHrr(190, 50, "2026-01-15", "USER");
    expect(set.method).toBe("hrr");
    expect(set.confidence).toBe("MEDIUM");
    expect(set.zones).toEqual([
      { zone: 1, minBpm: 120, maxBpm: 133 },
      { zone: 2, minBpm: 134, maxBpm: 147 },
      { zone: 3, minBpm: 148, maxBpm: 161 },
      { zone: 4, minBpm: 162, maxBpm: 175 },
      { zone: 5, minBpm: 176, maxBpm: 190 },
    ]);
    expect(HrZoneSetSchema.safeParse(set).success).toBe(true);
  });

  it("refuses implausible inputs instead of guessing", () => {
    expect(() => zonesFromLthr(60, "2026-01-01", "USER")).toThrow(RangeError);
    expect(() => zonesFromHrr(120, 95, "2026-01-01", "USER")).toThrow(RangeError);
    expect(() => zonesFromLthr(170, "2026-1-1", "USER")).toThrow(RangeError);
  });

  it("schema rejects non-contiguous or mis-numbered zones", () => {
    const set = zonesFromLthr(170, "2026-02-01", "GARMIN");
    const broken = {
      ...set,
      zones: set.zones.map((z) => (z.zone === 3 ? { ...z, minBpm: 155 } : z)),
    };
    expect(HrZoneSetSchema.safeParse(broken).success).toBe(false);
    const misnumbered = {
      ...set,
      zones: set.zones.map((z) => (z.zone === 2 ? { ...z, zone: 3 } : z)),
    };
    expect(HrZoneSetSchema.safeParse(misnumbered).success).toBe(false);
    expect(HrZoneSetSchema.safeParse({ ...set, extra: 1 }).success).toBe(false);
  });

  it("keeps history immutable: a February session uses February zones", () => {
    const feb = zonesFromLthr(165, "2026-02-01", "GARMIN");
    const may = zonesFromLthr(172, "2026-05-10", "GARMIN");
    expect(selectZoneSet([may, feb], "2026-02-14")?.lthr).toBe(165);
    expect(selectZoneSet([may, feb], "2026-05-10")?.lthr).toBe(172);
    expect(selectZoneSet([may, feb], "2026-09-28")?.lthr).toBe(172);
    expect(selectZoneSet([may, feb], "2026-01-01")).toBeNull();
  });

  it("maps bpm to zones, 0 below the floor", () => {
    const hrr = zonesFromHrr(190, 50, "2026-01-15", "USER");
    expect(zoneForHr(hrr, 100)).toBe(0);
    expect(zoneForHr(hrr, 120)).toBe(1);
    expect(zoneForHr(hrr, 150)).toBe(3);
    expect(zoneForHr(hrr, 175)).toBe(4);
    expect(zoneForHr(hrr, 195)).toBe(5);
    const lthr = zonesFromLthr(170, "2026-02-01", "GARMIN");
    expect(zoneForHr(lthr, 60)).toBe(1);
    expect(zoneForHr(lthr, 170)).toBe(5);
    expect(zoneForHr(lthr, Number.NaN)).toBe(0);
  });

  it("computes time in zones and skips null samples", () => {
    const set = zonesFromLthr(170, "2026-02-01", "GARMIN");
    const samples = [
      ...Array<number>(60).fill(140), // Z1
      ...Array<number>(120).fill(150), // Z2
      ...Array<number | null>(30).fill(null),
      ...Array<number>(30).fill(165), // Z4
    ];
    expect(timeInZones(set, samples, 5)).toEqual({ z1: 5, z2: 10, z3: 0, z4: 2.5, z5: 0 });
    expect(timeInZones(set, samples, 0)).toEqual({ z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 });
  });
});
