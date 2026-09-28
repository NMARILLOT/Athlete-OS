import { toConfidence } from "../core";
import type { ConfidenceResult, DerivedContext, ScoredCandidate } from "./types";

/** ENGINE.md §9 — min over components, baseline phase caps at MEDIUM. */
export function computeConfidence(
  ctx: DerivedContext,
  ranked: ScoredCandidate[],
  primary: ScoredCandidate | null,
): ConfidenceResult {
  const analysed = ctx.input.history.filter(
    (s) => !s.estimated && s.date >= addDaysSafe(ctx.today, -27),
  ).length;
  const data = analysed >= 8 ? 1 : analysed >= 4 ? 0.7 : 0.4;
  const readiness = ctx.input.readiness
    ? ctx.input.readiness.hasMeasured && ctx.input.readiness.hasDeclared
      ? 1
      : ctx.input.readiness.hasDeclared
        ? 0.75
        : 0.6
    : 0.4;
  const cls = ctx.todayFixed.find((p) => p.type === "crossfit");
  const todayWod = !cls
    ? 1
    : cls.profile && (cls.wodStatus === "confirmed" || (cls.wodConfidence ?? 0) >= 0.7)
      ? 1
      : cls.profile && (cls.wodConfidence ?? 0) >= 0.5
        ? 0.6
        : 0.4;
  const estimationShare = 1 - ctx.estimatedShare;
  const nonVetoed = ranked.filter((r) => !r.vetoed);
  const margin =
    nonVetoed.length >= 2 && primary
      ? Math.max(
          0.5,
          Math.min(
            1,
            (primary.score - (nonVetoed.find((r) => r !== primary)?.score ?? primary.score)) / 10 +
              0.5,
          ),
        )
      : 1;
  let scoreValue = Math.min(data, readiness, todayWod, estimationShare, margin);
  if (ctx.baselinePhase) scoreValue = Math.min(scoreValue, 0.7);
  const level = toConfidence(scoreValue);
  return {
    level: level === "HIGH" && scoreValue < 0.8 ? "MEDIUM" : level,
    score: Math.round(scoreValue * 100) / 100,
    components: {
      data,
      readiness,
      todayWod,
      estimationShare: Math.round(estimationShare * 100) / 100,
      margin: Math.round(margin * 100) / 100,
    },
  };
}

function addDaysSafe(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}
