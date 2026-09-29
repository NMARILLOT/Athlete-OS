import type { StimulusKey } from "../core";
import { DIMENSION_LABEL_FR, STIMULUS_LABEL_FR } from "./rules";
import type { DerivedContext, RuleHit, ScoredCandidate } from "./types";

/**
 * Short, factual French explanation (spec §62): ≤ 2 sentences built from the strongest rule hits,
 * the top gap covered and the contributing sessions.
 */
export function explain(
  ctx: DerivedContext,
  primary: ScoredCandidate,
  hits: RuleHit[],
  opts: { primaryDone: boolean; intentDeclined: boolean },
): string {
  const parts: string[] = [];
  const c = primary.candidate;

  if (opts.primaryDone)
    return `Séance principale déjà faite aujourd'hui (${primary.candidate.title}). Le reste est optionnel.`;

  if (c.fixed && c.family === "crossfit") {
    const covered = (Object.entries(c.expectedCredits) as Array<[StimulusKey, number]>)
      .filter(([, v]) => v >= 0.8)
      .map(([k]) => STIMULUS_LABEL_FR[k]);
    parts.push(
      c.origin === "crossfit_generic"
        ? "Classe CrossFit au programme, WOD inconnu : on planifie le reste autour."
        : `Parfait. Cette séance couvre aujourd'hui ${covered.length ? covered.join(" + ") : "ton stimulus CrossFit"}.`,
    );
  }

  const vetoes = hits.filter((h) => h.effect === "veto" && h.candidateKind !== c.kind);
  const strongestVeto =
    vetoes.find((h) => h.ruleId === "HIGH_LOWER_BODY_FATIGUE") ??
    vetoes.find((h) => h.ruleId === "HIGH_CARDIO_FATIGUE") ??
    vetoes.find((h) => h.ruleId === "HIGH_IMPACT_LOAD") ??
    vetoes.find((h) => h.ruleId === "HARD_SESSION_BUDGET_EXCEEDED") ??
    vetoes.find((h) => h.ruleId === "READINESS_POOR") ??
    vetoes[0];
  if (strongestVeto && !c.fixed) {
    const dim =
      strongestVeto.ruleId === "HIGH_LOWER_BODY_FATIGUE"
        ? "muscular_lower"
        : strongestVeto.ruleId === "HIGH_UPPER_BODY_FATIGUE"
          ? "muscular_upper"
          : strongestVeto.ruleId === "HIGH_CARDIO_FATIGUE"
            ? "cardiovascular"
            : strongestVeto.ruleId === "HIGH_IMPACT_LOAD"
              ? "impact"
              : null;
    if (dim) {
      const contrib = ctx.contributing[dim];
      const span = contrib.length
        ? daysSpan(
            contrib.map((x) => x.date),
            ctx.today,
          )
        : null;
      parts.push(
        `${contrib.length >= 2 ? `${contrib.length} gros stimuli ${DIMENSION_LABEL_FR[dim]} en ${span} jours` : `Gros stimulus ${DIMENSION_LABEL_FR[dim]} récent`} : ${strongestVeto.message.toLowerCase()}.`,
      );
    } else {
      parts.push(`${strongestVeto.message}.`);
    }
  }

  if (opts.intentDeclined)
    parts.push(
      `Mauvaise idée aujourd'hui telle quelle : on garde l'esprit avec ${c.title.toLowerCase()}.`,
    );

  if (!c.fixed && !c.recovery) {
    const top = primary.coveredKeys
      .map((k) => ({ k, gap: ctx.ledger[k].projectedGap }))
      .sort((a, b) => b.gap - a.gap)[0];
    if (top)
      parts.push(
        `${cap(c.title)} comble ce qui manque cette semaine (${STIMULUS_LABEL_FR[top.k]}) sans rajouter de fatigue inutile.`,
      );
  } else if (c.recovery) {
    const why =
      ctx.readinessBand === "poor"
        ? "récupération médiocre ce matin"
        : ctx.consecutiveTrainingDays >= 5
          ? `${ctx.consecutiveTrainingDays} jours d'affilée`
          : ctx.maxFatigueRatio >= 0.8
            ? "fatigue résiduelle élevée"
            : "rien de pressant cette semaine";
    parts.push(`${cap(c.title)} : ${why}. Le repos est une option parfaitement valide.`);
  }

  const notes = hits
    .filter((h) => h.effect === "note" && (h.candidateKind === c.kind || !h.candidateKind))
    .slice(0, 1);
  for (const n of notes) parts.push(n.message.endsWith(".") ? n.message : `${n.message}.`);

  const text = parts.slice(0, 3).join(" ");
  return text || `${cap(c.title)} aujourd'hui.`;
}

function daysSpan(dates: string[], today: string): number {
  const min = [...dates].sort()[0] ?? today;
  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${min}T00:00:00Z`);
  return Math.max(1, Math.round(ms / 86_400_000) + 1);
}
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
