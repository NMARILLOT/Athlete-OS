import {
  HARD_STIMULUS_KEYS,
  STIMULUS_KEY_VALUES,
  type LoadDimension,
  type MovementPattern,
  type StimulusKey,
} from "../core";
import { intentMatch } from "./candidates";
import { SCORING } from "./scoring";
import type { Candidate, DerivedContext, RuleKind, RuleOutcome } from "./types";

export interface Rule {
  id: string;
  kind: RuleKind;
  /** Candidate-level evaluation. Return null when the rule does not apply. */
  evaluate: (ctx: DerivedContext, c: Candidate) => RuleOutcome | null;
}

const veto = (
  id: string,
  kind: RuleKind,
  message: string,
  data?: Record<string, unknown>,
): RuleOutcome => ({ ruleId: id, kind, effect: "veto", message, data });
const score = (
  id: string,
  kind: RuleKind,
  s: number,
  message: string,
  data?: Record<string, unknown>,
): RuleOutcome => ({ ruleId: id, kind, effect: "score", score: s, message, data });
const note = (
  id: string,
  kind: RuleKind,
  message: string,
  data?: Record<string, unknown>,
): RuleOutcome => ({ ruleId: id, kind, effect: "note", message, data });

const LOWER_HEAVY = 6;
const UPPER_HEAVY = 6;

function dominantPattern(c: Candidate): MovementPattern | null {
  let best: MovementPattern | null = null;
  let bestV = 0;
  for (const [p, v] of Object.entries(c.patterns) as Array<[MovementPattern, number]>) {
    if (v > bestV) {
      best = p;
      bestV = v;
    }
  }
  return best;
}

function painMatches(c: Candidate, movements: string[], location: string): boolean {
  const lower = [
    "knee",
    "hip",
    "shin",
    "calf",
    "achilles",
    "ankle",
    "foot",
    "hamstring",
    "quad",
    "groin",
    "lower_back",
  ];
  const upper = ["shoulder", "elbow", "wrist", "neck", "upper_back"];
  if (
    movements.some(
      (m) =>
        (c.patterns as Record<string, number>)[m] !== undefined ||
        c.kind.includes(m) ||
        c.modality === m,
    )
  )
    return true;
  if (lower.includes(location))
    return (
      c.loadVector.muscular_lower >= 4 ||
      c.loadVector.impact >= 4 ||
      (location !== "lower_back" && c.modality === "running")
    );
  if (upper.includes(location)) return c.loadVector.muscular_upper >= 4;
  return false;
}

export const RULES: Rule[] = [
  {
    id: "HIGH_LOWER_BODY_FATIGUE",
    kind: "safety",
    evaluate: (ctx, c) => {
      if (c.fixed) return null;
      if (ctx.fatigueRatio.muscular_lower >= 1 && c.loadVector.muscular_lower >= LOWER_HEAVY) {
        return veto(
          "HIGH_LOWER_BODY_FATIGUE",
          "safety",
          `Fatigue jambes résiduelle élevée (${ctx.residual.muscular_lower}/${ctx.input.athleteModel.tolerance.muscular_lower})`,
          { contributing: ctx.contributing.muscular_lower },
        );
      }
      return null;
    },
  },
  {
    id: "HIGH_UPPER_BODY_FATIGUE",
    kind: "safety",
    evaluate: (ctx, c) => {
      if (c.fixed) return null;
      if (ctx.fatigueRatio.muscular_upper >= 1 && c.loadVector.muscular_upper >= UPPER_HEAVY) {
        return veto(
          "HIGH_UPPER_BODY_FATIGUE",
          "safety",
          `Fatigue haut du corps résiduelle élevée (${ctx.residual.muscular_upper})`,
          { contributing: ctx.contributing.muscular_upper },
        );
      }
      return null;
    },
  },
  {
    id: "HIGH_CARDIO_FATIGUE",
    kind: "safety",
    evaluate: (ctx, c) => {
      if (c.fixed) return null;
      if (ctx.fatigueRatio.cardiovascular >= 1 && c.intensity === "hard")
        return veto(
          "HIGH_CARDIO_FATIGUE",
          "safety",
          `Fatigue cardio résiduelle élevée (${ctx.residual.cardiovascular})`,
          { contributing: ctx.contributing.cardiovascular },
        );
      return null;
    },
  },
  {
    id: "HIGH_IMPACT_LOAD",
    kind: "safety",
    evaluate: (ctx, c) => {
      if (c.fixed) return null;
      const over = ctx.impact7dIU > ctx.impactToleranceIU || ctx.fatigueRatio.impact >= 1;
      if (over && c.loadVector.impact >= 5)
        return veto(
          "HIGH_IMPACT_LOAD",
          "safety",
          `Volume d'impact déjà élevé (${ctx.impact7dIU} IU sur 7 j, tolérance ${Math.round(ctx.impactToleranceIU)})`,
        );
      if (c.modality === "running" && ctx.impact7dIU > 0.8 * ctx.impactToleranceIU)
        return score(
          "HIGH_IMPACT_LOAD",
          "safety",
          -3,
          `Impacts proches de la tolérance hebdo (${ctx.impact7dIU}/${Math.round(ctx.impactToleranceIU)} IU)`,
        );
      return null;
    },
  },
  {
    id: "HARD_SESSION_BUDGET_EXCEEDED",
    kind: "safety",
    evaluate: (ctx, c) => {
      if (c.fixed || c.intensity !== "hard") return null;
      if (ctx.hardBudgetRemaining <= 0)
        return veto(
          "HARD_SESSION_BUDGET_EXCEEDED",
          "safety",
          `Budget de séances dures atteint (${ctx.hardDone6d} faites sur 6 j, ${ctx.hardFixedNext3d} classe(s) dure(s) à venir)`,
        );
      return null;
    },
  },
  {
    id: "HEAVY_STRENGTH_BUDGET",
    kind: "safety",
    evaluate: (ctx, c) => {
      if (c.fixed || !c.heavyStrength) return null;
      if (ctx.heavyStrength7d >= 3)
        return veto(
          "HEAVY_STRENGTH_BUDGET",
          "safety",
          `Déjà ${ctx.heavyStrength7d} séances de force lourde sur 7 j`,
        );
      return null;
    },
  },
  {
    id: "HARD_EASY_ALTERNATION",
    kind: "balance",
    evaluate: (ctx, c) => {
      if (c.fixed || c.intensity !== "hard") return null;
      if (ctx.hardYesterday)
        return score(
          "HARD_EASY_ALTERNATION",
          "balance",
          -3,
          "Séance dure hier : on alterne dur/facile",
        );
      if (ctx.hardFixedTomorrow)
        return score(
          "HARD_EASY_ALTERNATION",
          "balance",
          -3,
          "Classe dure demain : on garde du jus",
        );
      return null;
    },
  },
  {
    id: "PATTERN_REPEAT_72H",
    kind: "balance",
    evaluate: (ctx, c) => {
      if (c.fixed) return null;
      const p = dominantPattern(c);
      if (
        !p ||
        ![
          "squat",
          "hinge",
          "horizontal_push",
          "vertical_push",
          "horizontal_pull",
          "vertical_pull",
        ].includes(p)
      )
        return null;
      const recent = ctx.pattern72h[p] ?? 0;
      if (recent >= 3 && (c.patterns[p] ?? 0) >= 2)
        return score(
          "PATTERN_REPEAT_72H",
          "balance",
          -2,
          `Pattern ${p} déjà très sollicité sur 72 h (${recent.toFixed(1)})`,
        );
      return null;
    },
  },
  {
    id: "TOMORROW_HEAVY_CONFLICT",
    kind: "balance",
    evaluate: (ctx, c) => {
      if (c.fixed || !ctx.tomorrowDemand) return null;
      const d = ctx.tomorrowDemand.loadVector;
      if (d.muscular_lower >= LOWER_HEAVY && c.loadVector.muscular_lower >= LOWER_HEAVY)
        return score(
          "TOMORROW_HEAVY_CONFLICT",
          "balance",
          -3,
          `Demain charge lourdement les jambes (${ctx.tomorrowDemandSource === "prior" ? "classe, WOD inconnu" : "WOD connu"})`,
        );
      if (d.muscular_upper >= UPPER_HEAVY && c.loadVector.muscular_upper >= UPPER_HEAVY)
        return score(
          "TOMORROW_HEAVY_CONFLICT",
          "balance",
          -3,
          "Demain charge lourdement le haut du corps",
        );
      return null;
    },
  },
  {
    id: "FIXED_CLASS_RESERVE",
    kind: "balance",
    evaluate: (ctx, c) => {
      if (c.fixed) return null;
      if (!(ctx.todayClassUnknown || ctx.tomorrowClassUnknown)) return null;
      if (c.loadVector.muscular_lower >= LOWER_HEAVY || c.intensity === "hard")
        return score(
          "FIXED_CLASS_RESERVE",
          "balance",
          -3,
          ctx.todayClassUnknown
            ? "Classe CrossFit aujourd'hui, WOD inconnu : on réserve l'énergie"
            : "Classe CrossFit demain, WOD inconnu : on réserve l'énergie",
        );
      return null;
    },
  },
  {
    id: "CROSSFIT_COVERS_STIMULUS",
    kind: "balance",
    evaluate: (ctx, c) => {
      if (c.fixed || c.family === "crossfit") return null;
      const cls = ctx.todayFixed.find(
        (p) =>
          p.type === "crossfit" &&
          p.profile &&
          (p.wodStatus === "confirmed" || (p.wodConfidence ?? 0) >= 0.7),
      );
      if (!cls?.profile) return null;
      const covered = (Object.entries(cls.profile.expectedCredits) as Array<[StimulusKey, number]>)
        .filter(([, v]) => v >= 0.8)
        .map(([k]) => k);
      const dup = covered.filter((k) => (c.expectedCredits[k] ?? 0) >= 0.5);
      if (dup.length)
        return score(
          "CROSSFIT_COVERS_STIMULUS",
          "balance",
          -3,
          `La classe couvre déjà : ${dup.join(", ")}`,
          { covered },
        );
      return null;
    },
  },
  {
    id: "READINESS_POOR",
    kind: "safety",
    evaluate: (ctx, c) => {
      if (ctx.readinessBand !== "poor" || c.fixed) return null;
      if (c.intensity === "hard")
        return veto("READINESS_POOR", "safety", "Récupération médiocre ce matin (≥ 2 signaux)");
      if (c.intensity === "moderate")
        return score("READINESS_POOR", "safety", -2, "Récupération médiocre : on modère");
      return null;
    },
  },
  {
    id: "PAIN_ACTIVE",
    kind: "safety",
    evaluate: (ctx, c) => {
      for (const p of ctx.input.pain) {
        if (p.intensity >= 4 && painMatches(c, p.movements, p.location))
          return veto(
            "PAIN_ACTIVE",
            "safety",
            `Douleur ${p.location} ${p.intensity}/10 : on évite ce qui la sollicite`,
            { location: p.location },
          );
      }
      return null;
    },
  },
  {
    id: "PROTECT_EASY_VOLUME",
    kind: "balance",
    evaluate: (ctx, c) => {
      if (c.fixed) return null;
      const pol = ctx.polarisation14d;
      if (pol.totalMin < 90) return null;
      if (ctx.hardBudgetRemaining <= 0) return null; // already vetoed by the budget, no double counting
      const hardShare = pol.hardMin / pol.totalMin;
      const modShare = pol.moderateMin / pol.totalMin;
      // Graded: a CrossFit athlete sits naturally around 30–40 % hard minutes; only a real imbalance costs −3.
      if (c.intensity === "hard" && hardShare > 0.4)
        return score(
          "PROTECT_EASY_VOLUME",
          "balance",
          -3,
          `Trop d'intensité sur 14 j (${Math.round(100 * hardShare)} % dur) : on protège le volume facile`,
        );
      if (c.intensity === "hard" && hardShare > 0.25)
        return score(
          "PROTECT_EASY_VOLUME",
          "balance",
          -1,
          `Intensité déjà bien présente sur 14 j (${Math.round(100 * hardShare)} % dur)`,
        );
      if (c.intensity === "moderate" && modShare > 0.25)
        return score("PROTECT_EASY_VOLUME", "balance", -2, "Trop de zone grise sur 14 j");
      if (c.intensity === "moderate" && modShare > 0.15)
        return score("PROTECT_EASY_VOLUME", "balance", -1, "Zone grise déjà présente sur 14 j");
      return null;
    },
  },
  {
    id: "STALENESS",
    kind: "balance",
    evaluate: (ctx, c) => {
      if (c.fixed || c.recovery) return null;
      // Only the candidate's primary stimulus counts (largest credit), so minor keys never stack bonuses.
      let primaryKey: StimulusKey | null = null;
      let primaryCredit = 0;
      for (const k of STIMULUS_KEY_VALUES) {
        if (k === "aerobic_easy" || k === "mobility_recovery" || k === "crossfit_exposure")
          continue;
        const credit = c.expectedCredits[k] ?? 0;
        if (credit >= 0.5 && credit > primaryCredit) {
          primaryCredit = credit;
          primaryKey = k;
        }
      }
      if (!primaryKey) return null;
      const e = ctx.ledger[primaryKey];
      if (e.projectedGap <= 0) return null;
      // Never done in the lookback → +2 (it is a gap, not a "stale" habit); done but long ago → +3.
      const bonus =
        e.stalenessDays === null
          ? SCORING.rule.staleness
          : e.stalenessDays > 1.5 * e.windowDays
            ? SCORING.rule.stalenessLong
            : e.stalenessDays > e.windowDays
              ? SCORING.rule.staleness
              : 0;
      if (bonus === 0) return null;
      return score(
        "STALENESS",
        "balance",
        bonus,
        `${STIMULUS_LABEL_FR[primaryKey]} : pas d'exposition depuis ${e.stalenessDays === null ? "longtemps" : e.stalenessDays + " j"}`,
      );
    },
  },
  {
    id: "WEEKLY_RECOVERY_DAY",
    kind: "safety",
    evaluate: (ctx, c) => {
      if (c.fixed) return null;
      if (ctx.consecutiveTrainingDays >= 6) {
        if (c.intensity === "hard")
          return veto(
            "WEEKLY_RECOVERY_DAY",
            "safety",
            `${ctx.consecutiveTrainingDays} jours d'entraînement d'affilée : place à la récupération`,
          );
        if (c.recovery)
          return score(
            "WEEKLY_RECOVERY_DAY",
            "safety",
            SCORING.rule.recoveryDayVeto,
            `${ctx.consecutiveTrainingDays} jours d'affilée : une vraie récupération`,
          );
        return score(
          "WEEKLY_RECOVERY_DAY",
          "safety",
          -3,
          `${ctx.consecutiveTrainingDays} jours d'affilée`,
        );
      }
      if (ctx.restDaysThisWeek === 0 && ctx.remainingDays <= 2 && c.recovery)
        return score(
          "WEEKLY_RECOVERY_DAY",
          "safety",
          SCORING.rule.recoveryDayNudge,
          "Aucun jour de récupération cette semaine",
        );
      return null;
    },
  },
  {
    id: "LONG_SESSION_PLACEMENT",
    kind: "balance",
    evaluate: (ctx, c) => {
      if (c.fixed || c.durationMin < 90) return null;
      if (ctx.largestWindowMin > 0 && ctx.largestWindowMin < 90)
        return veto("LONG_SESSION_PLACEMENT", "balance", "Pas de créneau ≥ 90 min aujourd'hui");
      if (ctx.hardYesterday)
        return score(
          "LONG_SESSION_PLACEMENT",
          "balance",
          -3,
          "Séance dure hier : la sortie longue attendra",
        );
      // Default preference: long sessions live on the weekend unless a window or an intent says otherwise.
      const weekend = ctx.weekday >= 5;
      const asked =
        ctx.intent &&
        ["want_run", "want_bike", "have_time", "surprise", "want_big_session"].includes(
          ctx.intent.kind,
        );
      if (!weekend && ctx.largestWindowMin < 90 && !asked)
        return score(
          "LONG_SESSION_PLACEMENT",
          "balance",
          -3,
          "Sortie longue plutôt le week-end (ou dis-moi que tu as le temps)",
        );
      return null;
    },
  },
  {
    id: "DELOAD_ACTIVE",
    kind: "safety",
    evaluate: (ctx, c) => {
      if (!ctx.deloadActive || c.fixed) return null;
      if (c.isTest || c.family === "benchmark" || (c.expectedCredits.vo2max ?? 0) >= 0.5)
        return veto(
          "DELOAD_ACTIVE",
          "safety",
          "Deload en cours : pas de VO2max, test ni benchmark",
        );
      if (c.heavyStrength)
        return note("DELOAD_ACTIVE", "safety", "Deload : force à RPE ≤ 7, séries × 0.6");
      if (c.intensity === "hard") return score("DELOAD_ACTIVE", "safety", -4, "Deload en cours");
      return null;
    },
  },
  {
    id: "BASELINE_PHASE_CONSERVATIVE",
    kind: "safety",
    evaluate: (ctx, c) => {
      if (!ctx.baselinePhase || c.fixed) return null;
      if (c.intensity === "hard" && ctx.hardBudgetRemaining <= 0)
        return veto(
          "BASELINE_PHASE_CONSERVATIVE",
          "safety",
          "Phase d'apprentissage : max 2 séances dures proposées par semaine",
        );
      if (c.isTest)
        return veto(
          "BASELINE_PHASE_CONSERVATIVE",
          "safety",
          "Phase d'apprentissage : pas encore de test",
        );
      return null;
    },
  },
  {
    id: "INTENT_RESPECT",
    kind: "preference",
    evaluate: (ctx, c) => {
      if (!ctx.intent) return null;
      const m = intentMatch(ctx.intent, c);
      if (m === "exact")
        return score(
          "INTENT_RESPECT",
          "preference",
          SCORING.rule.intentExact,
          `Correspond à ton envie (${ctx.intent.kind})`,
        );
      if (m === "partial")
        return score(
          "INTENT_RESPECT",
          "preference",
          SCORING.rule.intentPartial,
          `Proche de ton envie (${ctx.intent.kind})`,
        );
      return null;
    },
  },
  {
    id: "PLAN_ADHERENCE",
    kind: "preference",
    evaluate: (_ctx, c) => {
      if (c.plannedId && !c.fixed)
        return score(
          "PLAN_ADHERENCE",
          "preference",
          SCORING.rule.adherence,
          "Séance prévue au programme",
        );
      return null;
    },
  },
  {
    id: "VARIETY",
    kind: "preference",
    evaluate: (ctx, c) => {
      if (c.fixed) return null;
      const last3 = ctx.input.history
        .filter((s) => s.date < ctx.today)
        .sort((a, b) => (a.date < b.date ? 1 : -1))
        .slice(0, 3);
      const streak = last3.length === 3 && last3.every((s) => s.kind === c.kind);
      let s = 0;
      const msgs: string[] = [];
      if (streak) {
        s += SCORING.rule.varietyMin;
        msgs.push("même séance trois jours de suite");
      }
      if (ctx.input.profile.preferences.favouriteModalities.includes(c.modality)) {
        s += SCORING.rule.varietyMax;
        msgs.push("sport que tu aimes");
      }
      if (ctx.input.profile.preferences.dislikedModalities.includes(c.modality)) {
        s += SCORING.rule.varietyMin;
        msgs.push("sport que tu n'aimes pas");
      }
      if (s === 0) return null;
      return score("VARIETY", "preference", s, msgs.join(", "));
    },
  },
  {
    id: "AVAILABILITY_FIT",
    kind: "safety",
    evaluate: (ctx, c) => {
      if (c.fixed || ctx.largestWindowMin <= 0 || c.durationMin === 0) return null;
      if (c.durationMin > ctx.largestWindowMin)
        return veto(
          "AVAILABILITY_FIT",
          "safety",
          `Plus long (${c.durationMin} min) que ton créneau (${ctx.largestWindowMin} min)`,
        );
      return null;
    },
  },
  {
    id: "TEST_OPPORTUNITY",
    kind: "balance",
    evaluate: (ctx, c) => {
      if (!c.isTest || c.fixed) return null;
      if (!ctx.fresh)
        return veto("TEST_OPPORTUNITY", "balance", "Pas assez frais pour un test utile");
      const needs =
        c.testKey === "run_5k"
          ? (ctx.input.profile.goalWeights.event_5k ?? 0) +
            (ctx.input.profile.goalWeights.endurance ?? 0)
          : c.testKey === "row_2k"
            ? (ctx.input.profile.goalWeights.crossfit ?? 0)
            : 0.5;
      if (needs >= 0.5)
        return score(
          "TEST_OPPORTUNITY",
          "balance",
          SCORING.rule.balance,
          "Frais, sans test récent : bonne fenêtre pour mesurer",
        );
      return null;
    },
  },
  {
    id: "EVENT_TAPER",
    kind: "safety",
    evaluate: (ctx, c) => {
      const e = ctx.eventWithinTaper;
      if (!e || c.fixed) return null;
      const specific =
        (e.kind === "running_race" || e.kind === "trail") &&
        c.modality === "running" &&
        c.intensity === "easy";
      const hyroxSpecific =
        e.kind === "hyrox" &&
        (c.family === "hyrox" || c.modality === "running") &&
        c.intensity !== "hard";
      if (specific || hyroxSpecific)
        return score("EVENT_TAPER", "safety", 3, `Affûtage avant ${e.name ?? e.kind}`);
      if (c.intensity === "hard" || c.heavyStrength)
        return veto(
          "EVENT_TAPER",
          "safety",
          `Affûtage avant ${e.name ?? e.kind} : pas de séance dure non spécifique`,
        );
      return null;
    },
  },
];

export const RULE_IDS = RULES.map((r) => r.id);

/** Keys counted as hard for the budget note in explanations. */
export function isHardKey(k: StimulusKey): boolean {
  return HARD_STIMULUS_KEYS.includes(k);
}

export function evaluateRules(
  ctx: DerivedContext,
  c: Candidate,
  rules: Rule[] = RULES,
): RuleOutcome[] {
  const out: RuleOutcome[] = [];
  for (const r of rules) {
    const o = r.evaluate(ctx, c);
    if (o) out.push(o);
  }
  return out;
}

export const STIMULUS_LABEL_FR: Record<StimulusKey, string> = {
  strength_lower: "force jambes",
  strength_upper: "force haut du corps",
  hypertrophy: "hypertrophie",
  olympic_technique: "technique haltéro",
  gymnastics_skill: "skill gymnastique",
  aerobic_easy: "endurance fondamentale",
  aerobic_long: "sortie longue",
  threshold: "seuil",
  vo2max: "VO2max",
  power: "puissance",
  crossfit_exposure: "CrossFit",
  hi_conditioning: "conditioning intense",
  mobility_recovery: "mobilité / récupération",
};

export const DIMENSION_LABEL_FR: Record<LoadDimension, string> = {
  cardiovascular: "cardio",
  muscular_lower: "jambes",
  muscular_upper: "haut du corps",
  impact: "impacts",
  eccentric: "excentrique",
  technical: "technique",
};

export { STIMULUS_KEY_VALUES };
