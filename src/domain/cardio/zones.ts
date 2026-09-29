import { z } from "zod";
import { CONFIDENCE_VALUES, DATA_SOURCE_VALUES, type DataSource } from "../core";
import { isIsoDate, type IsoDate } from "../core/dates";

/**
 * Versioned heart-rate zones (spec §16).
 *
 * Priority order when several sources could define the zones (spec §16):
 *   1. LTHR measured by Garmin and considered reliable        → method "lthr"
 *   2. A specific field test (5 km, 30-min TT, 2 km row …)     → method "test"
 *   3. Heart-rate reserve (Karvonen) from a measured max + RHR → method "hrr"
 *   4. Zones already present on the Garmin account            → method "garmin"
 *   A user-typed set is "manual".
 *
 * NEVER 220 − age: that formula is not implemented anywhere in this module, on purpose.
 *
 * Zone sets are immutable history: a session keeps the set that was valid on its date
 * (`selectZoneSet`), so February sessions are analysed with February zones even after an update.
 */
export const HR_ZONES_ALGORITHM_VERSION = "hr_zones_v1" as const;

export const HR_ZONE_METHOD_VALUES = ["lthr", "test", "hrr", "garmin", "manual"] as const;
export type HrZoneMethod = (typeof HR_ZONE_METHOD_VALUES)[number];

/** Spec §16 priority, best first. */
export const HR_ZONE_METHOD_PRIORITY: readonly HrZoneMethod[] = [
  "lthr",
  "test",
  "hrr",
  "garmin",
  "manual",
];

/** Upper bound written on Z5 when the method has no natural ceiling (LTHR / test). */
export const HR_ZONE_CEILING_BPM = 250;

export type HrZoneNumber = 1 | 2 | 3 | 4 | 5;

export const HrZoneSchema = z
  .object({
    zone: z.number().int().min(1).max(5),
    minBpm: z.number().int().min(0).max(HR_ZONE_CEILING_BPM),
    maxBpm: z.number().int().min(0).max(HR_ZONE_CEILING_BPM),
  })
  .strict();
export type HrZone = z.infer<typeof HrZoneSchema>;

/**
 * A zone set is five contiguous, ascending integer bpm bands: zone k spans
 * [minBpm, maxBpm] and zone k+1 starts at zone k's maxBpm + 1.
 */
export const HrZoneSetSchema = z
  .object({
    validFrom: z.string().refine(isIsoDate, "validFrom must be an IsoDate (YYYY-MM-DD)"),
    method: z.enum(HR_ZONE_METHOD_VALUES),
    lthr: z.number().int().positive().nullable().optional(),
    maxHr: z.number().int().positive().nullable().optional(),
    restingHr: z.number().int().positive().nullable().optional(),
    zones: z.array(HrZoneSchema).length(5),
    source: z.enum(DATA_SOURCE_VALUES),
    confidence: z.enum(CONFIDENCE_VALUES),
  })
  .strict()
  .superRefine((set, ctx) => {
    set.zones.forEach((zone, i) => {
      if (zone.zone !== i + 1) {
        ctx.addIssue({
          code: "custom",
          path: ["zones", i, "zone"],
          message: `expected zone ${i + 1}`,
        });
      }
      if (zone.minBpm > zone.maxBpm) {
        ctx.addIssue({ code: "custom", path: ["zones", i], message: "minBpm must be ≤ maxBpm" });
      }
      const prev = set.zones[i - 1];
      if (prev && zone.minBpm !== prev.maxBpm + 1) {
        ctx.addIssue({
          code: "custom",
          path: ["zones", i, "minBpm"],
          message: "zones must be contiguous",
        });
      }
    });
  });
export type HrZoneSet = z.infer<typeof HrZoneSetSchema>;

export interface TimeInZones {
  z1: number;
  z2: number;
  z3: number;
  z4: number;
  z5: number;
}

/** Plausibility guards — outside these the input is a typo, not a physiology. */
const LTHR_RANGE = { min: 100, max: 220 } as const;
const MAX_HR_RANGE = { min: 120, max: 230 } as const;
const RESTING_HR_RANGE = { min: 30, max: 100 } as const;

function assertRange(name: string, value: number, range: { min: number; max: number }): void {
  if (!Number.isFinite(value) || value < range.min || value > range.max) {
    throw new RangeError(`${name} out of range [${range.min}, ${range.max}]: ${value}`);
  }
}

function assertValidFrom(validFrom: string): void {
  if (!isIsoDate(validFrom)) throw new RangeError(`Invalid IsoDate: ${validFrom}`);
}

/** Build five contiguous zones from ascending lower bounds of Z2..Z5 plus a Z1 floor and a Z5 ceiling. */
function zonesFromBounds(
  floor: number,
  lowerBounds: [number, number, number, number],
  ceiling: number,
): HrZone[] {
  const starts = [floor, ...lowerBounds];
  return starts.map((minBpm, i) => ({
    zone: i + 1,
    minBpm,
    maxBpm: i < 4 ? (starts[i + 1] as number) - 1 : Math.max(ceiling, minBpm),
  }));
}

/**
 * Zones as a percentage of LTHR (Friel-style, spec §16 priority 1).
 *
 * | Zone | % LTHR   | Feel                    |
 * | ---- | -------- | ----------------------- |
 * | Z1   | < 85 %   | recovery / very easy    |
 * | Z2   | 85–89 %  | aerobic, conversational |
 * | Z3   | 90–94 %  | tempo                   |
 * | Z4   | 95–99 %  | sub-threshold           |
 * | Z5   | ≥ 100 %  | threshold and above     |
 *
 * Z1 has no physiological floor (everything below 85 % is recovery), so it starts at 0 bpm;
 * Z5 is capped at `HR_ZONE_CEILING_BPM`. Boundaries are rounded to the nearest bpm.
 */
export function zonesFromLthr(lthr: number, validFrom: IsoDate, source: DataSource): HrZoneSet {
  assertRange("lthr", lthr, LTHR_RANGE);
  assertValidFrom(validFrom);
  const bound = (pct: number): number => Math.round(lthr * pct);
  return {
    validFrom,
    method: "lthr",
    lthr: Math.round(lthr),
    maxHr: null,
    restingHr: null,
    zones: zonesFromBounds(
      0,
      [bound(0.85), bound(0.9), bound(0.95), bound(1)],
      HR_ZONE_CEILING_BPM,
    ),
    source,
    // Zones from a measured/estimated device LTHR are trusted; a hand-typed value is declared data (spec §70).
    confidence: source === "GARMIN" || source === "DEVICE" ? "HIGH" : "MEDIUM",
  };
}

/**
 * Karvonen zones from heart-rate reserve (spec §16 priority 3): bpm = RHR + p × (maxHR − RHR).
 * Z1 50–60 %, Z2 60–70 %, Z3 70–80 %, Z4 80–90 %, Z5 90–100 % of HRR. Below 50 % HRR is "zone 0".
 * MEDIUM confidence: it depends on a true max HR, which is rarely measured cleanly.
 */
export function zonesFromHrr(
  maxHr: number,
  restingHr: number,
  validFrom: IsoDate,
  source: DataSource,
): HrZoneSet {
  assertRange("maxHr", maxHr, MAX_HR_RANGE);
  assertRange("restingHr", restingHr, RESTING_HR_RANGE);
  assertValidFrom(validFrom);
  const reserve = maxHr - restingHr;
  if (reserve < 40) throw new RangeError(`heart-rate reserve too small: ${reserve} bpm`);
  const bound = (pct: number): number => Math.round(restingHr + pct * reserve);
  return {
    validFrom,
    method: "hrr",
    lthr: null,
    maxHr: Math.round(maxHr),
    restingHr: Math.round(restingHr),
    zones: zonesFromBounds(
      bound(0.5),
      [bound(0.6), bound(0.7), bound(0.8), bound(0.9)],
      Math.round(maxHr),
    ),
    source,
    confidence: "MEDIUM",
  };
}

/**
 * The zone set in force on `date`: latest `validFrom ≤ date`; null when none applies yet.
 * On an exact `validFrom` tie the later element of `sets` wins (most recently inserted).
 */
export function selectZoneSet(sets: readonly HrZoneSet[], date: IsoDate): HrZoneSet | null {
  let best: HrZoneSet | null = null;
  for (const set of sets) {
    if (set.validFrom > date) continue;
    if (!best || set.validFrom >= best.validFrom) best = set;
  }
  return best;
}

/** Zone 1..5 for a heart rate; 0 when below the Z1 floor or when the value is not a valid bpm. */
export function zoneForHr(set: HrZoneSet, bpm: number): 0 | HrZoneNumber {
  if (!Number.isFinite(bpm) || bpm <= 0) return 0;
  for (let i = set.zones.length - 1; i >= 0; i--) {
    const zone = set.zones[i] as HrZone;
    if (bpm >= zone.minBpm) return zone.zone as HrZoneNumber;
  }
  return 0;
}

/**
 * Minutes per zone from evenly spaced HR samples. Null / invalid samples and samples below the
 * Z1 floor are skipped (they add no time anywhere — never invented). Rounded to 0.01 min.
 */
export function timeInZones(
  set: HrZoneSet,
  hrSamples: ReadonlyArray<number | null | undefined>,
  sampleIntervalSec: number,
): TimeInZones {
  const out: TimeInZones = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
  if (!Number.isFinite(sampleIntervalSec) || sampleIntervalSec <= 0) return out;
  const counts = [0, 0, 0, 0, 0, 0];
  for (const bpm of hrSamples) {
    if (bpm == null) continue;
    const zone = zoneForHr(set, bpm);
    counts[zone] = (counts[zone] as number) + 1;
  }
  const minutes = (n: number): number => Math.round(((n * sampleIntervalSec) / 60) * 100) / 100;
  out.z1 = minutes(counts[1] as number);
  out.z2 = minutes(counts[2] as number);
  out.z3 = minutes(counts[3] as number);
  out.z4 = minutes(counts[4] as number);
  out.z5 = minutes(counts[5] as number);
  return out;
}
