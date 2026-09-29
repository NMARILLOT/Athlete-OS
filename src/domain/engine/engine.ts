import { LOAD_DIMENSION_VALUES, type StimulusKey, type Confidence } from "../core";
import { addDays, daysBetween, isoWeekEnd, type IsoDate } from "../core/dates";
import { WEEKLY_STRUCTURE } from "../athlete-model/defaults";
import { buildCandidates, getCatalogEntry, intentMatch } from "./candidates";
import { computeConfidence } from "./confidence";
import { deriveContext } from "./derive";
import { explain } from "./explain";
import { evaluateRules, RULES, type Rule } from "./rules";
import { coverage, interference, recoveryTerm } from "./scoring";
import {
  ENGINE_VERSION,
  type AskFor,
  type BonusDecision,
  type Candidate,
  type DayOutlook,
  type DerivedContext,
  type EngineInput,
  type HistorySession,
  type LoadProfile,
  type Option,
  type PlacementVerdict,
  type PlannedSession,
  type Recommendation,
  type Reschedule,
  type RuleHit,
  type ScoredCandidate,
} from "./types";

export interface EngineOptions {
  rules?: Rule[];
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export function scoreCandidate(
  ctx: DerivedContext,
  c: Candidate,
  rules: Rule[] = RULES,
): ScoredCandidate {
  const outcomes = evaluateRules(ctx, c, rules);
  const vetoed = outcomes.some((o) => o.effect === "veto");
  const cov = coverage(ctx, c);
  const inter = interference(ctx, c);
  const rec = recoveryTerm(ctx, c);
  const ruleScore = outcomes.reduce((a, o) => a + (o.effect === "score" ? (o.score ?? 0) : 0), 0);
  const score = round2(cov.coverage - inter + rec + ruleScore);
  return {
    candidate: c,
    coverage: cov.coverage,
    interference: inter,
    recovery: rec,
    ruleScore,
    score,
    vetoed,
    outcomes,
    coveredKeys: cov.coveredKeys,
  };
}

function toOption(s: ScoredCandidate, reason: string): Option {
  const c = s.candidate;
  return {
    kind: c.kind,
    family: c.family,
    title: c.title,
    origin: c.origin,
    timeOfDay: c.timeOfDay,
    templateId: c.templateId,
    plannedId: c.plannedId,
    fixed: c.fixed,
    isTest: c.isTest,
    testKey: c.testKey,
    expectedCredits: c.expectedCredits,
    loadVector: c.loadVector,
    intensity: c.intensity,
    heavyStrength: c.heavyStrength,
    durationMin: c.durationMin,
    modality: c.modality,
    patterns: c.patterns,
    impactUnits: c.impactUnits,
    score: s.score,
    reason,
  };
}

function hitsOf(ranked: ScoredCandidate[]): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const r of ranked)
    for (const o of r.outcomes) hits.push({ ...o, candidateKind: r.candidate.kind });
  return hits;
}

// ---------------------------------------------------------------------------
// Bonus gate (ENGINE.md §7)
// ---------------------------------------------------------------------------

function evaluateBonus(
  ctx: DerivedContext,
  primary: ScoredCandidate,
  ranked: ScoredCandidate[],
): BonusDecision {
  const p = primary.candidate;
  const refuse = (reason: string): BonusDecision => ({ kind: "none", reason });
  if (p.recovery || p.kind === "rest") return refuse("Journée de récupération : rien de plus.");
  if (ctx.baselinePhase) return refuse("Phase d'apprentissage : pas de double séance.");
  if (ctx.deloadActive) return refuse("Deload en cours : pas de double séance.");
  if (ctx.readinessBand === "poor")
    return refuse("Récupération médiocre : une seule séance aujourd'hui.");
  if (ctx.doublesThisWeek >= WEEKLY_STRUCTURE.maxDoubles)
    return refuse(`Déjà ${ctx.doublesThisWeek} doubles cette semaine.`);
  const freeDaysRemaining = Math.max(
    0,
    ctx.remainingDays -
      1 -
      ctx.input.planned.filter(
        (q) => q.fixed && q.date > ctx.today && q.date <= isoWeekEnd(ctx.today),
      ).length,
  );
  const primaryDurationMin = p.durationMin;
  const cap = ctx.dailyLoadCapAU;
  const estimatedPrimaryLoad =
    primaryDurationMin * (p.intensity === "hard" ? 8 : p.intensity === "moderate" ? 6 : 4);
  const classUnknown = p.origin === "crossfit_generic";

  const candidates = ranked.filter(
    (r) =>
      !r.vetoed &&
      r.candidate.kind !== p.kind &&
      !r.candidate.fixed &&
      r.candidate.intensity === "easy" &&
      r.candidate.durationMin > 0 &&
      r.candidate.kind !== "rest",
  );
  let firstReason: string | null = null;
  const noteReason = (reason: string) => {
    if (!firstReason) firstReason = reason;
  };
  for (const r of candidates.sort((a, b) => b.coverage - a.coverage)) {
    const c = r.candidate;
    if (LOAD_DIMENSION_VALUES.some((d) => c.loadVector[d] > 3)) continue;
    if (!(c.loadVector.impact <= 2 || p.loadVector.impact === 0)) continue;
    // Fatigue only matters in the dimensions the bonus actually loads.
    const tired = LOAD_DIMENSION_VALUES.filter(
      (d) => c.loadVector[d] > 1 && ctx.fatigueRatio[d] > 0.6,
    );
    if (tired.length) {
      noteReason(`Fatigue résiduelle trop élevée (${tired.join(", ")}) pour une double séance.`);
      continue;
    }
    // The gap must remain once the primary's own credits are counted.
    const key = (Object.entries(c.expectedCredits) as Array<[StimulusKey, number]>)
      .filter(([, v]) => v > 0)
      .map(([k]) => k)
      .find((k) => {
        const remaining = ctx.ledger[k].projectedGap - (p.expectedCredits[k] ?? 0);
        return remaining >= 0.8 && remaining > freeDaysRemaining * 0.8;
      });
    if (!key) {
      noteReason("Aucun stimulus manquant qu'un complément facile pourrait combler utilement.");
      continue;
    }
    if (classUnknown && c.durationMin > 20) continue;
    if (p.intensity === "hard" && c.durationMin > 30) continue;
    const estimatedBonusLoad = c.durationMin * 4;
    if (ctx.dayLoadDoneAU + estimatedPrimaryLoad + estimatedBonusLoad > cap) {
      noteReason(
        `Charge du jour déjà suffisante (${Math.round(ctx.dayLoadDoneAU + estimatedPrimaryLoad)} AU, plafond ${Math.round(cap)}).`,
      );
      continue;
    }
    if (
      ctx.availableMinutes > 0 &&
      primaryDurationMin + c.durationMin + 240 > ctx.availableMinutes + 240
    ) {
      // fits when total minutes within availability (gap handled by ordering, not minutes)
      if (primaryDurationMin + c.durationMin > ctx.availableMinutes) continue;
    }
    const before = p.timeOfDay === "evening" && !(p.loadVector.muscular_lower >= 6);
    const option = toOption(
      r,
      `Complément facile : comble ${key} (${(ctx.ledger[key].projectedGap - (p.expectedCredits[key] ?? 0)).toFixed(1)} manquant) sans fatigue notable.`,
    );
    option.timeOfDay = before ? "morning" : "evening";
    return option;
  }
  return refuse(firstReason ?? "Rien de plus aujourd'hui : la séance principale suffit.");
}

// ---------------------------------------------------------------------------
// Reschedule (ENGINE.md §6.5)
// ---------------------------------------------------------------------------

function heavyRegion(profile: LoadProfile): "lower" | "upper" | null {
  if (profile.loadVector.muscular_lower >= 6) return "lower";
  if (profile.loadVector.muscular_upper >= 6) return "upper";
  return null;
}

export function rescheduleSession(
  ctx: DerivedContext,
  planned: PlannedSession,
  primaryKind: string,
): Reschedule {
  const region = planned.profile ? heavyRegion(planned.profile) : null;
  const weekEnd = isoWeekEnd(ctx.today);
  const lastHeavy = (r: "lower" | "upper"): IsoDate | null => {
    const dim = r === "lower" ? "muscular_lower" : "muscular_upper";
    const dates = ctx.input.history
      .filter((s) => s.loadVector[dim] >= 6)
      .map((s) => s.date)
      .sort();
    return dates[dates.length - 1] ?? null;
  };
  // Candidate days are materialised first: an imported call in a `for` update clause whose body
  // holds closures is mis-compiled by the dev bundler (bare identifier instead of the import).
  const candidateDays: IsoDate[] = [];
  for (let k = 1; k <= 7; k++) {
    const day = addDays(ctx.today, k);
    if (day > weekEnd) break;
    candidateDays.push(day);
  }
  for (const d of candidateDays) {
    const fixedThatDay = ctx.input.planned.filter((p) => p.fixed && p.date === d);
    if (fixedThatDay.some((p) => p.type === "crossfit")) continue; // don't stack on a class day
    const nextDay = addDays(d, 1);
    const classNextDay = ctx.input.planned.find(
      (p) => p.fixed && p.type === "crossfit" && p.date === nextDay,
    );
    if (region && classNextDay) {
      const demand = classNextDay.profile ?? null;
      if (!demand || heavyRegion(demand) === region) continue;
    }
    if (region) {
      const lh = lastHeavy(region);
      if (lh && daysBetween(lh, d) < 2) continue;
      if (
        primaryKind &&
        region === "lower" &&
        daysBetween(ctx.today, d) < 2 &&
        ["run_hard", "strength_lower", "crossfit"].some((f) => primaryKind.includes(f))
      )
        continue;
    }
    return {
      plannedId: planned.id,
      fromDate: ctx.today,
      toDate: d,
      reason:
        "Jour libre compatible avec la récupération (pas de séance lourde ni de cours la veille).",
    };
  }
  return {
    plannedId: planned.id,
    fromDate: ctx.today,
    toDate: null,
    reason: "Aucun jour compatible cette semaine : repositionnée la semaine prochaine.",
  };
}

// ---------------------------------------------------------------------------
// runEngine
// ---------------------------------------------------------------------------

export function runEngine(input: EngineInput, options: EngineOptions = {}): Recommendation {
  const rules = options.rules ?? RULES;
  const ctx = deriveContext(input);
  const advice: Recommendation["advice"] = [];
  const askFor: AskFor[] = [];
  const reschedules: Reschedule[] = [];

  const weekday = ctx.weekday;
  const boxPrior = input.boxPriorByWeekday?.[weekday] ?? null;
  const allCandidates = buildCandidates({
    todayFixed: ctx.todayFixed,
    todayPlannedFree: ctx.todayPlannedFree,
    intent: ctx.intent,
    equipment: input.profile.equipmentAvailable,
    largestWindowMin: ctx.largestWindowMin,
    fresh: ctx.fresh,
    boxPrior,
  });

  // Primary already done today → only bonus/recovery candidates are evaluated.
  const primaryDone = ctx.primaryDoneToday !== null;
  const candidates = primaryDone
    ? allCandidates.filter((c) => c.recovery || c.intensity === "easy")
    : allCandidates;
  const ranked = candidates
    .map((c) => scoreCandidate(ctx, c, rules))
    .sort((a, b) => b.score - a.score);
  const hits = hitsOf(ranked);

  // Selection
  let primary: ScoredCandidate;
  let intentDeclined = false;
  const fixedScored = ranked.filter((r) => r.candidate.fixed);
  if (primaryDone && ctx.primaryDoneToday) {
    const done = ctx.primaryDoneToday;
    const doneCandidate: Candidate = {
      ...done,
      kind: done.kind ?? done.type,
      family: done.family ?? done.type,
      title: done.title ?? getCatalogEntry(done.kind ?? done.type)?.title ?? done.kind ?? done.type,
      equipment: [],
      recovery: false,
      origin: "done_today",
      profileConfidence: 1,
    };
    primary = {
      candidate: doneCandidate,
      coverage: 0,
      interference: 0,
      recovery: 0,
      ruleScore: 0,
      score: 0,
      vetoed: false,
      outcomes: [],
      coveredKeys: [],
    };
  } else if (fixedScored.length) {
    // Fixed session is the primary; safety vetoes become scale advice.
    primary = fixedScored.sort((a, b) => b.score - a.score)[0] as ScoredCandidate;
    const heavyLegs =
      ctx.fatigueRatio.muscular_lower >= 1 && primary.candidate.loadVector.muscular_lower >= 6;
    const poor = ctx.readinessBand === "poor";
    const budget =
      ctx.hardDone6d >= input.profile.maxHardSessionsPerWeek &&
      primary.candidate.intensity === "hard";
    if (heavyLegs)
      advice.push({
        code: "SCALE_ADVICE",
        text: "Garde la classe, allège la partie jambes (charge −20 %, pas de max).",
      });
    else if (poor)
      advice.push({
        code: "SCALE_ADVICE",
        text: "Garde la classe, mais en mode technique/allure contrôlée : récupération médiocre ce matin.",
      });
    else if (budget)
      advice.push({
        code: "SCALE_ADVICE",
        text: "Budget de séances dures déjà atteint : fais le WOD à 80 %, sans chasser le score.",
      });
    const cls = ctx.todayFixed.find((p) => p.type === "crossfit");
    if (cls && !cls.profile) askFor.push("wod");
    else if (cls && cls.profile && cls.wodStatus !== "confirmed" && (cls.wodConfidence ?? 0) < 0.7)
      askFor.push("wod_review");
  } else {
    const nonVetoed = ranked.filter((r) => !r.vetoed);
    if (ctx.intent) {
      const exactAll = ranked.filter(
        (r) => intentMatch(ctx.intent as NonNullable<typeof ctx.intent>, r.candidate) === "exact",
      );
      const exactOk = exactAll.filter((r) => !r.vetoed);
      if (exactAll.length && !exactOk.length) {
        intentDeclined = true;
        // Nearest safe variant: same family with lower intensity/shorter, else partial family, else best.
        const nearest =
          nonVetoed.find(
            (r) =>
              intentMatch(ctx.intent as NonNullable<typeof ctx.intent>, r.candidate) === "partial",
          ) ?? nonVetoed[0];
        primary = nearest ?? (ranked[0] as ScoredCandidate);
        hits.push({
          ruleId: "INTENT_DECLINED_WITH_ALTERNATIVE",
          kind: "preference",
          effect: "note",
          message: `Ton envie (${ctx.intent.kind}) est incompatible aujourd'hui : ${exactAll[0]?.outcomes.find((o) => o.effect === "veto")?.message ?? "sécurité"}.`,
          candidateKind: primary.candidate.kind,
        });
      } else {
        primary = nonVetoed[0] ?? (ranked[0] as ScoredCandidate);
      }
    } else {
      primary = nonVetoed[0] ?? (ranked[0] as ScoredCandidate);
    }
    if (ctx.intent?.kind === "going_crossfit" && primary.candidate.origin === "crossfit_generic")
      askFor.push("wod");
  }

  // Alternatives: different families, non-vetoed.
  const confidence = computeConfidence(ctx, ranked, primary);
  const altCount = confidence.level === "LOW" ? 3 : 2;
  const alternatives: Option[] = [];
  const seenFamilies = new Set<string>([primary.candidate.family]);
  for (const r of ranked) {
    if (r.vetoed || r === primary || r.candidate.fixed) continue;
    if (seenFamilies.has(r.candidate.family)) continue;
    seenFamilies.add(r.candidate.family);
    alternatives.push(
      toOption(
        r,
        r.outcomes.find((o) => o.effect === "score" && (o.score ?? 0) > 0)?.message ??
          "Option compatible avec ta récupération.",
      ),
    );
    if (alternatives.length >= altCount) break;
  }

  // Reschedule today's planned free session if it is not the primary.
  for (const p of ctx.todayPlannedFree) {
    if (primary.candidate.plannedId === p.id) continue;
    const r = rescheduleSession(ctx, p, primary.candidate.kind);
    reschedules.push(r);
    hits.push({
      ruleId: "RESCHEDULE_SUGGESTED",
      kind: "balance",
      effect: "note",
      message: r.reason,
      data: { plannedId: p.id, toDate: r.toDate },
      candidateKind: primary.candidate.kind,
    });
  }

  // Bonus
  const bonus = evaluateBonus(ctx, primary, ranked);

  // Advice: pain / missing readiness / missing RPE
  for (const p of input.pain) {
    if (p.intensity >= 7 || (p.sudden && p.persistent)) {
      advice.push({
        code: "MEDICAL_ADVICE",
        text: `Douleur ${p.location} ${p.intensity}/10${p.sudden ? ", apparue soudainement" : ""}${p.persistent ? ", persistante" : ""} : l'app adapte l'entraînement mais ne diagnostique pas. Un avis médical est justifié.`,
      });
      break;
    }
  }
  if (!input.readiness) askFor.push("readiness");
  const missingRpe = input.history.filter(
    (s) =>
      s.date >= addDays(ctx.today, -2) &&
      s.rpe == null &&
      s.type !== "rest" &&
      s.type !== "mobility",
  );
  if (missingRpe.length) {
    askFor.push("rpe");
    advice.push({
      code: "MISSING_RPE",
      text: `RPE manquant sur ${missingRpe.length} séance(s) récente(s) : la charge est estimée.`,
    });
  }

  const rulesTriggered = dedupeHits([
    ...hits.filter((h) => h.candidateKind === primary.candidate.kind || h.effect === "note"),
    ...hits.filter((h) => h.effect === "veto"),
  ]);
  const explanation = explain(ctx, primary, hits, { primaryDone, intentDeclined });

  const primaryOption = toOption(
    primary,
    primary.outcomes
      .filter((o) => o.effect === "score")
      .map((o) => o.message)
      .slice(0, 2)
      .join(" · ") || "Meilleur compromis aujourd'hui.",
  );

  return {
    date: ctx.today,
    engineVersion: ENGINE_VERSION,
    primary: primaryOption,
    primaryDone,
    bonus,
    alternatives,
    reschedules,
    advice,
    askFor: [...new Set(askFor)],
    deloadProposal: null,
    explanation,
    confidence,
    rulesTriggered,
    trace: {
      derived: {
        residual: ctx.residual,
        fatigueRatio: ctx.fatigueRatio,
        hardDone6d: ctx.hardDone6d,
        hardFixedNext3d: ctx.hardFixedNext3d,
        hardBudgetRemaining: ctx.hardBudgetRemaining,
        heavyStrength7d: ctx.heavyStrength7d,
        impact7dIU: ctx.impact7dIU,
        impactToleranceIU: round2(ctx.impactToleranceIU),
        consecutiveTrainingDays: ctx.consecutiveTrainingDays,
        restDaysThisWeek: ctx.restDaysThisWeek,
        readinessBand: ctx.readinessBand,
        fresh: ctx.fresh,
        deloadActive: ctx.deloadActive,
        topGaps: Object.values(ctx.ledger)
          .filter((e) => e.projectedGap > 0)
          .sort((a, b) => b.projectedGap * b.urgency - a.projectedGap * a.urgency)
          .slice(0, 4)
          .map((e) => ({ key: e.key, projectedGap: e.projectedGap, urgency: e.urgency })),
        tomorrowDemandSource: ctx.tomorrowDemandSource,
      },
      candidates: ranked.map((r) => ({
        kind: r.candidate.kind,
        score: r.score,
        coverage: r.coverage,
        interference: r.interference,
        recovery: r.recovery,
        ruleScore: r.ruleScore,
        vetoed: r.vetoed,
        outcomes: r.outcomes.map((o) => ({ ruleId: o.ruleId, effect: o.effect, score: o.score })),
      })),
    },
  };
}

function dedupeHits(hits: RuleHit[]): RuleHit[] {
  const seen = new Set<string>();
  const out: RuleHit[] = [];
  for (const h of hits) {
    const k = `${h.ruleId}|${h.candidateKind ?? ""}|${h.effect}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(h);
  }
  return out;
}

// ---------------------------------------------------------------------------
// projectWeek / checkPlacement (ENGINE.md §0)
// ---------------------------------------------------------------------------

function optionToHistory(
  o: Option & { recoveryLike: boolean },
  date: IsoDate,
  id: string,
): HistorySession {
  return {
    id,
    date,
    endTime: `${date}T18:00:00Z`,
    type:
      o.family === "crossfit"
        ? "crossfit"
        : o.family.startsWith("strength") ||
            o.family === "accessory" ||
            o.family === "olympic" ||
            o.family === "gymnastics"
          ? "strength"
          : o.recoveryLike
            ? "mobility"
            : "cardio",
    kind: o.kind,
    family: o.family,
    rpe: null,
    funScore: null,
    sessionRpeLoad:
      o.durationMin * (o.intensity === "hard" ? 8 : o.intensity === "moderate" ? 6 : 4),
    estimated: true,
    expectedCredits: o.expectedCredits,
    loadVector: o.loadVector,
    intensity: o.intensity,
    heavyStrength: o.heavyStrength,
    durationMin: o.durationMin,
    modality: o.modality,
    patterns: o.patterns,
    impactUnits: o.impactUnits,
  } as HistorySession;
}

// `recoveryLike` is not on Option; derive from kind.
function withRecoveryFlag(o: Option): Option & { recoveryLike: boolean } {
  return {
    ...o,
    recoveryLike: ["rest", "mobility", "walk", "recovery_spin", "just_move"].includes(o.family),
  };
}

export function projectWeek(
  input: EngineInput,
  days = 7,
  options: EngineOptions = {},
): DayOutlook[] {
  const out: DayOutlook[] = [];
  let history = [...input.history];
  for (let k = 0; k < days; k++) {
    const date = addDays(input.today, k);
    const dayInput: EngineInput = {
      ...input,
      today: date,
      now: k === 0 ? input.now : `${date}T08:00:00Z`,
      history,
      intents: k === 0 ? input.intents : input.intents.filter((i) => i.date === date),
      readiness: k === 0 ? input.readiness : null,
      availability: k === 0 ? input.availability : null,
    };
    const rec = runEngine(dayInput, options);
    out.push({
      date,
      primary: rec.primary,
      bonus: rec.bonus,
      fixed: input.planned.filter((p) => p.date === date && p.fixed),
      confidence: rec.confidence.level,
      rulesTriggered: rec.rulesTriggered.map((h) => h.ruleId),
      explanation: rec.explanation,
    });
    if (rec.primary.kind !== "rest" && !rec.primaryDone)
      history = [...history, optionToHistory(withRecoveryFlag(rec.primary), date, `proj-${date}`)];
    if (rec.bonus.kind !== "none")
      history = [
        ...history,
        optionToHistory(withRecoveryFlag(rec.bonus as Option), date, `proj-bonus-${date}`),
      ];
  }
  return out;
}

export function checkPlacement(
  input: EngineInput,
  session: LoadProfile & { kind: string; title: string; family?: string },
  targetDate: IsoDate,
  options: EngineOptions = {},
): PlacementVerdict {
  const rules = options.rules ?? RULES;
  const offset = daysBetween(input.today, targetDate);
  const history = [...input.history];
  if (offset > 0) {
    const outlook = projectWeek(input, offset, options);
    for (const day of outlook) {
      if (day.primary.kind !== "rest")
        history.push(optionToHistory(withRecoveryFlag(day.primary), day.date, `proj-${day.date}`));
    }
  }
  const dayInput: EngineInput = {
    ...input,
    today: targetDate,
    now: offset === 0 ? input.now : `${targetDate}T08:00:00Z`,
    history,
    intents: [],
    readiness: offset === 0 ? input.readiness : null,
    availability: offset === 0 ? input.availability : null,
  };
  const ctx = deriveContext(dayInput);
  const candidate: Candidate = {
    ...session,
    family: session.family ?? session.kind,
    title: session.title,
    equipment: [],
    recovery: false,
    origin: "placement",
    profileConfidence: 1,
  };
  const outcomes = evaluateRules(ctx, candidate, rules).filter(
    (o) => o.ruleId !== "PLAN_ADHERENCE",
  );
  const veto = outcomes.some((o) => o.effect === "veto");
  const warn = outcomes.some(
    (o) => (o.effect === "score" && (o.score ?? 0) <= -3) || o.effect === "note",
  );
  const verdict = veto ? "veto" : warn ? "warn" : "ok";
  const summary = veto
    ? `Mauvaise idée le ${targetDate} : ${outcomes.find((o) => o.effect === "veto")?.message ?? "règle de sécurité"}.`
    : warn
      ? `Possible le ${targetDate}, mais attention : ${outcomes
          .filter((o) => (o.score ?? 0) <= -3 || o.effect === "note")
          .map((o) => o.message)
          .join(" ; ")}.`
      : `OK le ${targetDate}.`;
  return { date: targetDate, verdict, outcomes, summary };
}

export function confidenceLabel(c: Confidence): string {
  return c === "HIGH"
    ? "Confiance élevée"
    : c === "MEDIUM"
      ? "Confiance moyenne"
      : "Confiance faible";
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
