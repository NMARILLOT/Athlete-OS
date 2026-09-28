import { IMPACT_DIM_PER_IU, IMPACT_UNITS } from "../athlete-model/defaults";

export const IMPACT_ALGORITHM_VERSION = "impact_units_v1" as const;

export interface ImpactCounts {
  runKm?: number;
  walkKm?: number;
  doubleUnders?: number;
  singleUnders?: number;
  boxJumps?: number;
  burpees?: number;
  jumpingLunges?: number;
}

/** Impact units (spec §47): 1 IU ≈ 1 km running = 200 double-unders = 30 box jumps = 30 burpees. */
export function impactUnits(c: ImpactCounts): number {
  const iu =
    (c.runKm ?? 0) * IMPACT_UNITS.perRunKm +
    (c.walkKm ?? 0) * IMPACT_UNITS.perWalkKm +
    (c.doubleUnders ?? 0) * IMPACT_UNITS.perDoubleUnder +
    (c.singleUnders ?? 0) * IMPACT_UNITS.perSingleUnder +
    (c.boxJumps ?? 0) * IMPACT_UNITS.perBoxJump +
    (c.burpees ?? 0) * IMPACT_UNITS.perBurpee +
    (c.jumpingLunges ?? 0) * IMPACT_UNITS.perJumpingLunge;
  return Math.round(iu * 100) / 100;
}

/** Session impact dimension (0..10) from impact units. */
export function impactDimension(iu: number): number {
  return Math.min(10, Math.round(IMPACT_DIM_PER_IU * iu * 100) / 100);
}
