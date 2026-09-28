import "server-only";
import { env } from "./env";

/** Feature flags (spec §101, ARCHITECTURE.md §8). Env-driven; UI hides entry points, services throw. */
export interface FeatureFlags {
  garmin: boolean;
  aiCoach: boolean;
  bodyComp: boolean;
  advancedReadiness: boolean;
  experimentalMetrics: boolean;
}

const truthy = (v: string | undefined) => v === "true" || v === "1" || v === "on";

export function flags(): FeatureFlags {
  const e = env();
  return {
    garmin: truthy(e.FLAG_GARMIN),
    aiCoach: truthy(e.FLAG_AI_COACH),
    bodyComp: truthy(e.FLAG_BODY_COMP),
    advancedReadiness: truthy(e.FLAG_ADVANCED_READINESS),
    experimentalMetrics: truthy(e.FLAG_EXPERIMENTAL_METRICS),
  };
}

export class FeatureDisabledError extends Error {
  constructor(public readonly flag: keyof FeatureFlags) {
    super(`Feature disabled: ${flag}`);
    this.name = "FeatureDisabledError";
  }
}

export function requireFlag(flag: keyof FeatureFlags): void {
  if (!flags()[flag]) throw new FeatureDisabledError(flag);
}
