import { ACTUAL_SCALING } from "../athlete-model/defaults";
import type { LoadVector } from "../core";
import { scaleLoadVector } from "./fatigue";

export const ACTUAL_SCALING_VERSION = "actual_scaling_v1" as const;

/**
 * Planned → actual load: scale a template load vector by how the session actually went.
 *   factor = clamp(rpe/expectedRpe, 0.6, 1.4) × clamp(√(actualMin/plannedMin), 0.7, 1.3)
 * Missing RPE or duration → that factor is 1 (and the caller lowers confidence).
 */
export function scaleTemplateLoadToActual(
  template: LoadVector,
  actual: {
    rpe?: number | null;
    expectedRpe?: number | null;
    actualMin?: number | null;
    plannedMin?: number | null;
  },
): { loadVector: LoadVector; factor: number; estimated: boolean } {
  const c = ACTUAL_SCALING;
  let rpeFactor = 1;
  let estimated = false;
  if (
    typeof actual.rpe === "number" &&
    typeof actual.expectedRpe === "number" &&
    actual.expectedRpe > 0
  ) {
    rpeFactor = Math.min(c.rpeRatioMax, Math.max(c.rpeRatioMin, actual.rpe / actual.expectedRpe));
  } else estimated = true;
  let durFactor = 1;
  if (
    typeof actual.actualMin === "number" &&
    typeof actual.plannedMin === "number" &&
    actual.plannedMin > 0 &&
    actual.actualMin > 0
  ) {
    durFactor = Math.min(
      c.durationRatioMax,
      Math.max(c.durationRatioMin, Math.sqrt(actual.actualMin / actual.plannedMin)),
    );
  }
  const factor = Math.round(rpeFactor * durFactor * 100) / 100;
  return { loadVector: scaleLoadVector(template, factor), factor, estimated };
}
