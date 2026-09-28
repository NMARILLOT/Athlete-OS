import {
  LOAD_DIMENSION_VALUES,
  type LoadDimension,
  type LoadVector,
  type UserIntent,
  emptyLoadVector,
} from "../core";
import {
  addDays,
  daysBetween,
  hoursBetween,
  isoWeekStart,
  isoWeekday,
  remainingDaysInWeek,
  type IsoDate,
} from "../core/dates";
import { DAILY_LOAD_CAP, FRESHNESS, WEEKLY_STRUCTURE } from "../athlete-model/defaults";
import { computeLedger } from "../stimulus/ledger";
import { patternExposure72h } from "../stimulus/exposure";
import { crossfitClassPrior } from "./candidates";
import type {
  DerivedContext,
  EngineEvent,
  EngineInput,
  HistorySession,
  LoadProfile,
  PlannedSession,
} from "./types";

/** Which planned sessions count as "hard" for the lookahead (unknown-WOD class counts as hard). */
export function plannedIsHard(p: PlannedSession): boolean {
  if (p.type === "crossfit") return p.profile ? p.profile.intensity === "hard" : true;
  return p.profile?.intensity === "hard";
}

function isPrimaryLevel(s: HistorySession): boolean {
  if (s.type === "rest" || s.type === "mobility") return false;
  if (
    s.family === "walk" ||
    s.family === "mobility" ||
    s.family === "just_move" ||
    s.family === "recovery_spin"
  )
    return false;
  return s.durationMin >= 25 || s.intensity !== "easy";
}

function isRestLike(s: HistorySession): boolean {
  return !isPrimaryLevel(s);
}

export function deriveContext(input: EngineInput): DerivedContext {
  const { today, now } = input;
  const model = input.athleteModel;
  const weekStart = isoWeekStart(today);
  const history = input.history.filter((s) => s.date <= today);

  // Residual fatigue + contributions
  const residual = emptyLoadVector();
  const contributing: DerivedContext["contributing"] = {
    cardiovascular: [],
    muscular_lower: [],
    muscular_upper: [],
    impact: [],
    eccentric: [],
    technical: [],
  };
  let estimatedResidual = 0;
  let totalResidual = 0;
  for (const s of history) {
    const hours = hoursBetween(s.endTime, now);
    if (hours < 0) continue;
    for (const dim of LOAD_DIMENSION_VALUES) {
      const c = s.loadVector[dim] * Math.pow(0.5, hours / model.halfLivesH[dim]);
      if (c <= 0) continue;
      residual[dim] += c;
      totalResidual += c;
      if (s.estimated) estimatedResidual += c;
      contributing[dim].push({ id: s.id, date: s.date, contribution: c, kind: s.kind });
    }
  }
  for (const dim of LOAD_DIMENSION_VALUES) {
    residual[dim] = round2(residual[dim]);
    contributing[dim].sort((a, b) => b.contribution - a.contribution);
    contributing[dim] = contributing[dim]
      .slice(0, 3)
      .map((c) => ({ ...c, contribution: round2(c.contribution) }));
  }
  const fatigueRatio = {} as Record<LoadDimension, number>;
  let maxFatigueRatio = 0;
  for (const dim of LOAD_DIMENSION_VALUES) {
    fatigueRatio[dim] = round2(residual[dim] / model.tolerance[dim]);
    maxFatigueRatio = Math.max(maxFatigueRatio, fatigueRatio[dim]);
  }

  // Planned sets
  const tomorrow = addDays(today, 1);
  const todayFixed = input.planned.filter((p) => p.date === today && p.fixed);
  const todayPlannedFree = input.planned.filter((p) => p.date === today && !p.fixed);
  const tomorrowFixed = input.planned.filter((p) => p.date === tomorrow && p.fixed);
  const weekEnd = addDays(weekStart, 6);
  const fixedClassesThisWeek =
    input.planned.filter(
      (p) => p.fixed && p.type === "crossfit" && p.date >= weekStart && p.date <= weekEnd,
    ).length + history.filter((s) => s.type === "crossfit" && s.date >= weekStart).length;

  // Ledger (rolling windows) with fixed planned credits projected to the end of the ISO week.
  const ledger = computeLedger({
    today,
    targets: input.profile.targets,
    history: history.map((s) => ({ date: s.date, credits: s.expectedCredits })),
    plannedFixed: input.planned
      .filter((p) => p.fixed && p.date > today)
      .map((p) => ({
        date: p.date,
        credits:
          (p.profile ?? (p.type === "crossfit" ? crossfitClassPrior() : null))?.expectedCredits ??
          {},
      })),
  });

  // Hard budget with lookahead
  const sixDaysAgo = addDays(today, -6);
  const hardDone6d = history.filter((s) => s.intensity === "hard" && s.date >= sixDaysAgo).length;
  const yesterday = addDays(today, -1);
  const hardYesterday = history.some((s) => s.intensity === "hard" && s.date === yesterday);
  const next3 = addDays(today, 3);
  const hardFixedNext3d = input.planned.filter(
    (p) => p.fixed && p.date > today && p.date <= next3 && plannedIsHard(p),
  ).length;
  const hardFixedTomorrow = tomorrowFixed.some(plannedIsHard);
  const baselinePhase = input.profile.baselinePhase;
  const maxHard = input.deload?.active ? 1 : input.profile.maxHardSessionsPerWeek;
  const hardBudgetRemaining = baselinePhase
    ? Math.max(0, WEEKLY_STRUCTURE.baselineMaxHardEngineProposed - fixedClassesThisWeek) -
      hardDone6d +
      history.filter((s) => s.type === "crossfit" && s.intensity === "hard" && s.date >= sixDaysAgo)
        .length
    : maxHard - hardDone6d - hardFixedNext3d;
  const heavyStrength7d = history.filter(
    (s) => s.heavyStrength && s.date >= addDays(today, -6),
  ).length;

  // Impact budget
  const impact7dIU = round2(
    history.filter((s) => s.date >= sixDaysAgo).reduce((a, s) => a + s.impactUnits, 0),
  );

  // Polarisation over 14 days (cardio + metcon minutes)
  const fourteen = addDays(today, -13);
  const pol = { hardMin: 0, moderateMin: 0, easyMin: 0, totalMin: 0 };
  for (const s of history) {
    if (s.date < fourteen) continue;
    const cardioish =
      s.loadVector.cardiovascular >= 1.5 || s.type === "cardio" || s.type === "crossfit";
    if (!cardioish) continue;
    if (s.intensity === "hard") pol.hardMin += s.durationMin;
    else if (s.intensity === "moderate") pol.moderateMin += s.durationMin;
    else pol.easyMin += s.durationMin;
    pol.totalMin += s.durationMin;
  }

  // Consecutive training days ending today (today counts if a session is done)
  const byDate = new Map<IsoDate, HistorySession[]>();
  for (const s of history) byDate.set(s.date, [...(byDate.get(s.date) ?? []), s]);
  let consecutiveTrainingDays = 0;
  for (let d = today; ; d = addDays(d, -1)) {
    const sessions = byDate.get(d) ?? [];
    const trained = sessions.some(isPrimaryLevel);
    if (d === today && !trained) continue; // today not yet trained → look at the streak up to yesterday
    if (!trained) break;
    consecutiveTrainingDays++;
    if (consecutiveTrainingDays > 60) break;
  }
  let restDaysThisWeek = 0;
  for (let d = weekStart; d < today; d = addDays(d, 1)) {
    const sessions = byDate.get(d) ?? [];
    if (!sessions.some(isPrimaryLevel)) restDaysThisWeek++;
  }
  const doneToday = byDate.get(today) ?? [];
  const primaryDoneToday = doneToday.find(isPrimaryLevel) ?? null;
  let doublesThisWeek = 0;
  for (let d = weekStart; d <= today; d = addDays(d, 1)) {
    const sessions = (byDate.get(d) ?? []).filter((s) => !isRestLike(s) || s.durationMin >= 20);
    if (sessions.filter((s) => s.type !== "mobility" && s.type !== "rest").length >= 2)
      doublesThisWeek++;
  }
  const dayLoadDoneAU = doneToday.reduce((a, s) => a + (s.sessionRpeLoad ?? 0), 0);
  const dailyLoadCapAU = Math.max(
    DAILY_LOAD_CAP.minAU,
    DAILY_LOAD_CAP.factor * model.meanDailyLoadAU,
  );

  // Tomorrow's demand
  let tomorrowDemand: LoadProfile | null = null;
  let tomorrowDemandSource: DerivedContext["tomorrowDemandSource"] = "none";
  for (const p of tomorrowFixed) {
    let prof: LoadProfile | null = null;
    if (p.profile && (p.wodStatus === "confirmed" || (p.wodConfidence ?? 0) >= 0.7)) {
      prof = p.profile;
      tomorrowDemandSource = "analysis";
    } else if (p.type === "crossfit") {
      const wd = isoWeekday(p.date);
      const learned = input.boxPriorByWeekday?.[wd];
      prof = learned && learned.confidence >= 0.5 ? learned.profile : crossfitClassPrior();
      tomorrowDemandSource = "prior";
    } else if (p.profile) {
      prof = p.profile;
      tomorrowDemandSource = "analysis";
    }
    if (prof) tomorrowDemand = tomorrowDemand ? maxProfile(tomorrowDemand, prof) : prof;
  }
  const todayClassUnknown = todayFixed.some(
    (p) =>
      p.type === "crossfit" &&
      !(p.profile && (p.wodStatus === "confirmed" || (p.wodConfidence ?? 0) >= 0.7)),
  );
  const tomorrowClassUnknown = tomorrowFixed.some(
    (p) =>
      p.type === "crossfit" &&
      !(p.profile && (p.wodStatus === "confirmed" || (p.wodConfidence ?? 0) >= 0.7)),
  );

  // Readiness, freshness, tests, events, intent, availability
  const readinessBand = input.readiness?.band ?? "unknown";
  const lastHardHours = history
    .filter((s) => s.intensity === "hard")
    .reduce((min, s) => Math.min(min, hoursBetween(s.endTime, now)), Infinity);
  let daysSinceLastTest: number | null = null;
  for (const d of Object.values(input.lastTestDates ?? {})) {
    if (!d) continue;
    const n = daysBetween(d, today);
    if (daysSinceLastTest === null || n < daysSinceLastTest) daysSinceLastTest = n;
  }
  const fresh =
    maxFatigueRatio <= FRESHNESS.maxFatigueRatio &&
    readinessBand === "good" &&
    lastHardHours >= FRESHNESS.noHardHours &&
    (daysSinceLastTest === null || daysSinceLastTest >= FRESHNESS.noTestDays);
  let eventWithinTaper: EngineEvent | null = null;
  for (const e of input.events ?? []) {
    const d = daysBetween(today, e.date);
    if (
      d >= 0 &&
      d <= e.taperDays &&
      (!eventWithinTaper || d < daysBetween(today, eventWithinTaper.date))
    )
      eventWithinTaper = e;
  }
  const intent = pickIntent(input.intents, today);
  const windows = input.availability?.windows ?? [];
  const largestWindowMin =
    windows.reduce((m, w) => Math.max(m, w.endMinute - w.startMinute), 0) ||
    (intent?.availableMinutes ?? 0) ||
    0;
  const availableMinutes = Math.max(
    input.availability?.totalMinutes ?? 0,
    intent?.availableMinutes ?? 0,
  );

  return {
    input,
    today,
    now,
    weekday: isoWeekday(today),
    remainingDays: remainingDaysInWeek(today),
    residual,
    fatigueRatio,
    maxFatigueRatio: round2(maxFatigueRatio),
    contributing,
    pattern72h: patternExposure72h(
      history.map((s) => ({ date: s.date, patternExposure: s.patterns, muscleExposure: {} })),
      today,
    ),
    ledger,
    hardDone6d,
    hardYesterday,
    hardFixedNext3d,
    hardFixedTomorrow,
    fixedClassesThisWeek,
    hardBudgetRemaining,
    heavyStrength7d,
    impact7dIU,
    impactToleranceIU: model.impactWeeklyToleranceIU * (input.deload?.active ? 0.5 : 1),
    polarisation14d: pol,
    consecutiveTrainingDays,
    restDaysThisWeek,
    doneToday,
    primaryDoneToday,
    doublesThisWeek,
    dayLoadDoneAU,
    dailyLoadCapAU,
    todayFixed,
    todayPlannedFree,
    tomorrowFixed,
    tomorrowDemand,
    tomorrowDemandSource,
    todayClassUnknown,
    tomorrowClassUnknown,
    readinessBand,
    fresh,
    deloadActive: Boolean(input.deload?.active),
    baselinePhase,
    intent,
    availableMinutes,
    largestWindowMin,
    eventWithinTaper,
    daysSinceLastTest,
    estimatedShare: totalResidual > 0 ? round2(estimatedResidual / totalResidual) : 0,
  };
}

function pickIntent(intents: UserIntent[], today: IsoDate): UserIntent | null {
  const active = intents.filter((i) => (i.date ?? today) === today);
  return active[0] ?? null;
}

function maxProfile(a: LoadProfile, b: LoadProfile): LoadProfile {
  const lvx: LoadVector = { ...a.loadVector };
  for (const dim of LOAD_DIMENSION_VALUES)
    lvx[dim] = Math.max(a.loadVector[dim], b.loadVector[dim]);
  return {
    ...a,
    loadVector: lvx,
    intensity: a.intensity === "hard" || b.intensity === "hard" ? "hard" : a.intensity,
    heavyStrength: a.heavyStrength || b.heavyStrength,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
