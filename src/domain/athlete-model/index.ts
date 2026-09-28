import { DEFAULT_HALF_LIVES_H, DEFAULT_TOLERANCE, IMPACT_WEEKLY_TOLERANCE, DAILY_LOAD_CAP } from "./defaults";
import type { AthleteModelParams } from "./types";

export * from "./defaults";
export * from "./types";
export * from "./baselines";

/** Build the merged params from defaults + learned overrides (flat keys like `fatigue_half_life.muscular_lower`). */
export function buildAthleteModel(
  learned: Readonly<Record<string, number>> = {},
  context: { meanWeeklyImpactIU?: number; meanDailyLoadAU?: number } = {},
): AthleteModelParams {
  const halfLivesH = { ...DEFAULT_HALF_LIVES_H };
  const tolerance = { ...DEFAULT_TOLERANCE };
  const exerciseCostMultipliers: Record<string, number> = {};
  for (const [key, value] of Object.entries(learned)) {
    if (!Number.isFinite(value) || value <= 0) continue;
    const [group, name] = key.split(".") as [string, string | undefined];
    if (!name) continue;
    if (group === "fatigue_half_life" && name in halfLivesH) halfLivesH[name as keyof typeof halfLivesH] = value;
    else if (group === "tolerance" && name in tolerance) tolerance[name as keyof typeof tolerance] = value;
    else if (group === "exercise_cost") exerciseCostMultipliers[name] = value;
  }
  const meanWeeklyImpactIU = context.meanWeeklyImpactIU ?? 0;
  return {
    halfLivesH,
    tolerance,
    exerciseCostMultipliers,
    impactWeeklyToleranceIU: Math.max(IMPACT_WEEKLY_TOLERANCE.floorIU, IMPACT_WEEKLY_TOLERANCE.factor * meanWeeklyImpactIU),
    meanDailyLoadAU: Math.max(DAILY_LOAD_CAP.minAU / DAILY_LOAD_CAP.factor, context.meanDailyLoadAU ?? 0),
  };
}
