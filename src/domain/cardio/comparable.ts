import type { IntensityBand, Modality } from "../core";

/**
 * Comparable session groups (spec §30): never compare arbitrary sessions. Two sessions are only
 * put side by side when they share a group key AND their conditions are close enough.
 */
export const COMPARABLE_GROUP_VERSION = "comparable_group_v1" as const;

export const COMPARABLE_RULES = {
  /** Elevation gain per km at or above which the terrain is "hilly". */
  hillyElevationPerKmM: 10,
  /** Duration bucket edges in minutes: <45, 45–75, 75–120, >120. */
  durationEdgesMin: [45, 75, 120] as const,
  /** Max temperature difference for two sessions to stay comparable, when both are known. */
  temperatureToleranceC: 8,
  /** Max relative distance difference (shorter / longer ≥ 1 − tolerance), when both are known. */
  distanceTolerancePct: 25,
} as const;

export interface ComparableSessionInput {
  modality: Modality;
  durationMin: number;
  distanceM?: number | null;
  elevationGainM?: number | null;
  intensity: IntensityBand;
  /** Only meaningful for bike / row / ski (venue token). */
  indoor?: boolean | null;
  temperatureC?: number | null;
}

export type TerrainToken = "flat" | "hilly";
export type DurationBucket = "under45min" | "45_75min" | "75_120min" | "over120min";

const MODALITY_TOKEN: Record<Modality, string> = {
  running: "run",
  bike: "bike",
  row: "row",
  ski: "ski",
  swimming: "swim",
  walking: "walk",
  strength: "strength",
  gymnastics: "gymnastics",
  weightlifting: "weightlifting",
  mixed_modal: "mixed_modal",
  mobility: "mobility",
  other: "other",
};

/** Modalities whose sessions differ by venue (erg / trainer vs outdoors). */
const VENUE_MODALITIES: readonly Modality[] = ["bike", "row", "ski"];
/** Modalities where terrain matters (outdoors only). */
const TERRAIN_MODALITIES: readonly Modality[] = ["running", "bike", "walking"];

export function durationBucket(durationMin: number): DurationBucket {
  const [a, b, c] = COMPARABLE_RULES.durationEdgesMin;
  if (durationMin < a) return "under45min";
  if (durationMin < b) return "45_75min";
  if (durationMin <= c) return "75_120min";
  return "over120min";
}

/** Flat when elevation gain per km < 10 m, hilly otherwise; null when distance or elevation is unknown. */
export function terrainToken(
  distanceM: number | null | undefined,
  elevationGainM: number | null | undefined,
): TerrainToken | null {
  if (
    distanceM == null ||
    elevationGainM == null ||
    !(distanceM > 0) ||
    !Number.isFinite(elevationGainM)
  )
    return null;
  return elevationGainM / (distanceM / 1000) >= COMPARABLE_RULES.hillyElevationPerKmM
    ? "hilly"
    : "flat";
}

/**
 * Deterministic key `<intensity>_<modality>[_<terrain>][_<venue>]_<duration>`:
 *  - intensity: easy | moderate | hard
 *  - modality: run | bike | row | ski | swim | walk | …
 *  - terrain (running / walking / outdoor bike, when distance + elevation are known): flat | hilly
 *  - venue (bike / row / ski, when the indoor flag is known): indoor | outdoor
 *  - duration: under45min | 45_75min | 75_120min | over120min
 * Examples: `easy_run_flat_45_75min`, `easy_bike_indoor_75_120min`, `hard_row_indoor_under45min`.
 */
export function classifyComparableGroup(a: ComparableSessionInput): string {
  const parts: string[] = [a.intensity, MODALITY_TOKEN[a.modality]];
  const venue =
    VENUE_MODALITIES.includes(a.modality) && typeof a.indoor === "boolean"
      ? a.indoor
        ? "indoor"
        : "outdoor"
      : null;
  if (TERRAIN_MODALITIES.includes(a.modality) && venue !== "indoor") {
    const terrain = terrainToken(a.distanceM, a.elevationGainM);
    if (terrain) parts.push(terrain);
  }
  if (venue) parts.push(venue);
  parts.push(durationBucket(a.durationMin));
  return parts.join("_");
}

/**
 * Same group AND, when both known, |ΔT| ≤ 8 °C AND distances within 25 % of each other
 * (shorter / longer ≥ 0.75).
 */
export function isComparable(a: ComparableSessionInput, b: ComparableSessionInput): boolean {
  if (classifyComparableGroup(a) !== classifyComparableGroup(b)) return false;
  if (a.temperatureC != null && b.temperatureC != null) {
    if (Math.abs(a.temperatureC - b.temperatureC) > COMPARABLE_RULES.temperatureToleranceC)
      return false;
  }
  if (a.distanceM != null && b.distanceM != null && a.distanceM > 0 && b.distanceM > 0) {
    const ratio = Math.min(a.distanceM, b.distanceM) / Math.max(a.distanceM, b.distanceM);
    if (ratio < 1 - COMPARABLE_RULES.distanceTolerancePct / 100) return false;
  }
  return true;
}
