import "server-only";
import { and, desc, eq, gte, lte, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  athleteModelParams,
  athleteProfiles,
  dailyReadiness,
  events,
  goals,
  painLogs,
  trainingBlocks,
  travelPeriods,
  userIntents,
  userPreferences,
  weeklyStimulusTargets,
  workoutAnalyses,
  workouts,
  availabilityWindows,
  testResults,
  users,
  wodInboxItems,
  crossfitWorkouts,
} from "@/db/schema";
import { buildAthleteModel } from "@/domain/athlete-model";
import { addDays, isoWeekStart, isoWeekday, type IsoDate } from "@/domain/core/dates";
import type { ActivePain, Equipment, GoalWeights, UserIntent, TimeWindow } from "@/domain/core";
import type {
  EngineInput,
  HistorySession,
  LoadProfile,
  PlannedSession,
  ReadinessSnapshot,
} from "@/domain/engine";
import { deriveWeeklyTargets } from "@/domain/stimulus";
import { crossfitClassPrior } from "@/domain/engine";
import { sessionRpeLoad } from "@/domain/load";
import { localDate, localIso, localMinute } from "@/server/time";

export const DEFAULT_GOALS: GoalWeights = {
  health_longevity: 1,
  crossfit: 0.9,
  endurance: 0.9,
  strength: 0.9,
  physique: 0.6,
  fun: 0.7,
};
const DEFAULT_EQUIPMENT: Equipment[] = [
  "barbell",
  "rack",
  "bench",
  "pull_up_bar",
  "dumbbell",
  "kettlebell",
  "rower",
  "bike_erg",
  "ski_erg",
  "outdoor",
  "bodyweight",
  "wall_ball",
  "box",
  "jump_rope",
  "rings",
];

/**
 * Assemble the pure EngineInput from the database (ARCHITECTURE §4 "Recompute"): a handful of indexed
 * queries over the last 28 days + next 7 days. Everything the engine decides is reproducible from
 * this snapshot, which is persisted next to the recommendation.
 */
export async function assembleEngineInput(
  db: Db,
  userId: string,
  opts: { now: Date; timezone: string; today?: IsoDate },
): Promise<EngineInput> {
  const now = opts.now;
  const nowIso = localIso(now, opts.timezone);
  const today = opts.today ?? nowIso.slice(0, 10);
  const from = addDays(today, -28);
  const to = addDays(today, 7);

  const [userRow] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const [profile] = await db
    .select()
    .from(athleteProfiles)
    .where(eq(athleteProfiles.userId, userId))
    .limit(1);
  const [prefs] = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  const goalRows = await db
    .select()
    .from(goals)
    .where(and(eq(goals.userId, userId), eq(goals.active, true)));
  const goalWeights: GoalWeights = goalRows.length
    ? Object.fromEntries(goalRows.map((g) => [g.key, g.weight]))
    : { ...DEFAULT_GOALS };

  // Active blocks, newest first (same order as profile.service `activeBlocks`). A recovery block
  // (deload) and a focus block coexist: the deload always wins, the focus block only shapes targets.
  const blockRows = await db
    .select()
    .from(trainingBlocks)
    .where(
      and(
        eq(trainingBlocks.userId, userId),
        lte(trainingBlocks.startsOn, today),
        sql`(${trainingBlocks.endsOn} is null or ${trainingBlocks.endsOn} >= ${today})`,
        sql`${trainingBlocks.endedBy} is null`,
      ),
    )
    .orderBy(desc(trainingBlocks.startsOn), desc(trainingBlocks.createdAt));
  const deloadBlock = blockRows.find((b) => b.focus === "recovery") ?? null;
  const block = blockRows.find((b) => b.focus !== "recovery") ?? null;
  const deloadActive = deloadBlock !== null;

  const weekStart = isoWeekStart(today);
  const targetRows = await db
    .select()
    .from(weeklyStimulusTargets)
    .where(
      and(eq(weeklyStimulusTargets.userId, userId), eq(weeklyStimulusTargets.weekStart, weekStart)),
    );
  const userTargets = targetRows.find((t) => t.source === "USER")?.targets;
  const maxHard = prefs?.maxHardSessionsPerWeek ?? 3;
  const targets =
    userTargets ??
    deriveWeeklyTargets({
      goalWeights,
      blockFocus: block?.focus ?? "custom",
      weeklyHoursTarget: profile?.weeklyHoursTarget ?? 7,
      maxHardSessionsPerWeek: maxHard,
      deloadActive,
      overrides: block?.stimulusTargets ?? undefined,
    });

  // History: done workouts with their ACTUAL analysis (fallback planned), last 28 days incl. today.
  const doneRows = await db
    .select({ w: workouts, a: workoutAnalyses })
    .from(workouts)
    .leftJoin(
      workoutAnalyses,
      and(eq(workoutAnalyses.workoutId, workouts.id), eq(workoutAnalyses.phase, "actual")),
    )
    .where(
      and(
        eq(workouts.userId, userId),
        eq(workouts.status, "done"),
        gte(workouts.date, from),
        lte(workouts.date, today),
      ),
    );
  const plannedFallbackIds = doneRows.filter((r) => !r.a).map((r) => r.w.id);
  const plannedAnalyses = plannedFallbackIds.length
    ? await db
        .select()
        .from(workoutAnalyses)
        .where(
          and(
            inArray(workoutAnalyses.workoutId, plannedFallbackIds),
            eq(workoutAnalyses.phase, "planned"),
          ),
        )
    : [];
  const plannedById = new Map(plannedAnalyses.map((a) => [a.workoutId, a]));
  const history: HistorySession[] = [];
  for (const { w, a } of doneRows) {
    const analysis = a ?? plannedById.get(w.id) ?? null;
    const profileLoad: LoadProfile =
      w.type === "rest"
        ? restLoadProfile(analysis?.stimulusCredits ?? {})
        : analysis
          ? {
              expectedCredits: analysis.stimulusCredits,
              loadVector: analysis.loadVector,
              intensity: analysis.intensity,
              heavyStrength: analysis.heavyStrength,
              durationMin: w.actualDurationMin ?? w.plannedDurationMin ?? 45,
              modality: modalityOfType(w.type),
              patterns: analysis.patternExposure,
              impactUnits: analysis.impactUnits,
            }
          : w.type === "crossfit"
            ? { ...crossfitClassPrior(), durationMin: w.actualDurationMin ?? 60 }
            : {
                expectedCredits: {},
                loadVector: {
                  cardiovascular: 1,
                  muscular_lower: 1,
                  muscular_upper: 1,
                  impact: 0,
                  eccentric: 0,
                  technical: 0,
                },
                intensity: w.realisedIntensity ?? w.plannedIntensity ?? "easy",
                heavyStrength: false,
                durationMin: w.actualDurationMin ?? w.plannedDurationMin ?? 30,
                modality: modalityOfType(w.type),
                patterns: {},
                impactUnits: 0,
              };
    const durationMin = profileLoad.durationMin;
    history.push({
      id: w.id,
      date: w.date,
      endTime: sessionEndTime(w, durationMin, opts.timezone).toISOString(),
      type: w.type,
      kind: kindOf(w),
      family: familyOf(w),
      title: w.title,
      rpe: w.rpe,
      funScore: null,
      sessionRpeLoad: w.sessionRpeLoad ?? sessionRpeLoad(durationMin, w.rpe),
      // A rest day has nothing to estimate: its zero load is exact by definition.
      estimated: w.type === "rest" ? false : !a,
      ...profileLoad,
      intensity: w.type === "rest" ? "easy" : (w.realisedIntensity ?? profileLoad.intensity),
    });
  }

  // Planned: today..+7 (planned, in_progress or auto_adjusted — a moved session is still planned),
  // with WOD status for fixed classes.
  const plannedRows = await db
    .select({ w: workouts, a: workoutAnalyses, cf: crossfitWorkouts })
    .from(workouts)
    .leftJoin(
      workoutAnalyses,
      and(eq(workoutAnalyses.workoutId, workouts.id), eq(workoutAnalyses.phase, "planned")),
    )
    .leftJoin(crossfitWorkouts, eq(crossfitWorkouts.workoutId, workouts.id))
    .where(
      and(
        eq(workouts.userId, userId),
        inArray(workouts.status, [...ENGINE_PLANNED_STATUSES]),
        gte(workouts.date, today),
        lte(workouts.date, to),
      ),
    );
  const inboxIds = plannedRows
    .map((r) => r.cf?.wodInboxItemId)
    .filter((x): x is string => Boolean(x));
  const inboxRows = inboxIds.length
    ? await db
        .select({
          id: wodInboxItems.id,
          status: wodInboxItems.status,
          parseConfidence: wodInboxItems.parseConfidence,
        })
        .from(wodInboxItems)
        .where(inArray(wodInboxItems.id, inboxIds))
    : [];
  const inboxById = new Map(inboxRows.map((r) => [r.id, r]));
  const planned: PlannedSession[] = plannedRows.map(({ w, a, cf }) => {
    const inbox = cf?.wodInboxItemId ? inboxById.get(cf.wodInboxItemId) : undefined;
    const wodStatus: PlannedSession["wodStatus"] =
      w.type !== "crossfit"
        ? "none"
        : inbox?.status === "confirmed"
          ? "confirmed"
          : inbox?.status === "needs_review"
            ? "needs_review"
            : inbox
              ? "parsed"
              : a
                ? "confirmed"
                : "none";
    const profileLoad: LoadProfile | null = a
      ? {
          expectedCredits: a.stimulusCredits,
          loadVector: a.loadVector,
          intensity: a.intensity,
          heavyStrength: a.heavyStrength,
          durationMin: w.plannedDurationMin ?? 60,
          modality: modalityOfType(w.type),
          patterns: a.patternExposure,
          impactUnits: a.impactUnits,
        }
      : null;
    return {
      id: w.id,
      date: w.date,
      type: w.type,
      title: w.title,
      startMinute: w.startAt ? localMinute(w.startAt, opts.timezone) : null,
      fixed: w.fixed,
      status: w.status === "in_progress" ? "in_progress" : "planned",
      kind: kindOf(w),
      family: familyOf(w),
      profile: profileLoad,
      wodStatus,
      wodConfidence: inbox?.parseConfidence ?? (a ? 1 : null),
    };
  });

  // Readiness (declared summary), pain, intents, availability, events, tests, athlete model
  const [readinessRow] = await db
    .select()
    .from(dailyReadiness)
    .where(and(eq(dailyReadiness.userId, userId), eq(dailyReadiness.date, today)))
    .limit(1);
  const readiness: ReadinessSnapshot | null = readinessRow?.summary
    ? {
        band: readinessRow.summary.band,
        hasDeclared: readinessRow.summary.hasDeclared,
        hasMeasured: readinessRow.summary.hasMeasured,
        signals: readinessRow.summary.signals.map((s) => s.key),
      }
    : readinessRow && readinessRow.energy != null
      ? {
          band: bandFromDeclared(
            readinessRow.energy,
            readinessRow.soreness ?? 0,
            readinessRow.motivation ?? 2,
            readinessRow.unusualPain,
          ),
          hasDeclared: true,
          hasMeasured: false,
          signals: [],
        }
      : null;

  const painRows = await db
    .select()
    .from(painLogs)
    .where(and(eq(painLogs.userId, userId), inArray(painLogs.status, ["active", "improving"])));
  const pain: ActivePain[] = painRows.map((p) => ({
    location: p.location,
    side: (p.side as ActivePain["side"]) ?? undefined,
    intensity: p.intensity,
    movementSpecific: p.movementSpecific,
    movements: p.movements,
    sudden: p.sudden,
    persistent: p.persistent,
    reportedAt: p.reportedAt.toISOString(),
  }));

  // Single-day intents (ends_on null) apply only when declared for today; ranged intents apply
  // while starts_on ≤ today ≤ ends_on. Yesterday's "repos" must never steer today.
  const intentRows = await db
    .select()
    .from(userIntents)
    .where(
      and(
        eq(userIntents.userId, userId),
        eq(userIntents.status, "active"),
        lte(userIntents.startsOn, today),
        sql`((${userIntents.endsOn} is null and ${userIntents.startsOn} = ${today}) or ${userIntents.endsOn} >= ${today})`,
      ),
    )
    .orderBy(desc(userIntents.declaredAt));
  const intents: UserIntent[] = intentRows
    .filter((i) => i.endsOn != null || i.startsOn === today)
    .map((i) => ({
      kind: i.kind,
      intensity: i.params.intensity ?? undefined,
      availableMinutes: i.params.availableMinutes ?? undefined,
      rawText: i.rawText ?? undefined,
      date: today,
    }));

  const wd = isoWeekday(today);
  const windowRows = await db
    .select()
    .from(availabilityWindows)
    .where(
      and(
        eq(availabilityWindows.userId, userId),
        sql`(${availabilityWindows.date} = ${today} or (${availabilityWindows.date} is null and ${availabilityWindows.weekday} = ${wd}))`,
      ),
    );
  const windows: TimeWindow[] = windowRows
    .filter((w) => w.kind === "available")
    .map((w) => ({ startMinute: w.startMinute, endMinute: w.endMinute }));
  const availability = windows.length
    ? { windows, totalMinutes: windows.reduce((a, w) => a + (w.endMinute - w.startMinute), 0) }
    : null;

  const eventRows = await db
    .select()
    .from(events)
    .where(
      and(eq(events.userId, userId), gte(events.date, today), lte(events.date, addDays(today, 21))),
    );
  const testRows = await db
    .select({ testKey: testResults.testKey, date: sql<string>`max(${testResults.date})` })
    .from(testResults)
    .where(eq(testResults.userId, userId))
    .groupBy(testResults.testKey);

  const paramRows = await db
    .select()
    .from(athleteModelParams)
    .where(eq(athleteModelParams.userId, userId));
  const learned = Object.fromEntries(paramRows.map((p) => [p.key, p.value]));
  const weeksWithData = Math.max(1, Math.min(4, Math.ceil(history.length / 4)));
  const meanWeeklyImpactIU = history.reduce((a, s) => a + s.impactUnits, 0) / weeksWithData;
  const loads = history.map((s) => s.sessionRpeLoad ?? 0);
  const meanDailyLoadAU = loads.length ? loads.reduce((a, b) => a + b, 0) / 28 : 0;

  const travel = await db
    .select()
    .from(travelPeriods)
    .where(
      and(
        eq(travelPeriods.userId, userId),
        lte(travelPeriods.startsOn, today),
        gte(travelPeriods.endsOn, today),
      ),
    )
    .limit(1);
  const equipmentAvailable = (
    travel[0]?.equipment?.length
      ? travel[0].equipment
      : profile?.equipment?.length
        ? profile.equipment
        : DEFAULT_EQUIPMENT
  ) as Equipment[];

  const baselinePhase = profile?.baselinePhaseUntil
    ? profile.baselinePhaseUntil >= today
    : !userRow?.onboardingCompletedAt || history.length < 6;

  return {
    now: nowIso,
    today,
    profile: {
      goalWeights,
      targets,
      baselinePhase,
      maxHardSessionsPerWeek: maxHard,
      weeklyHoursTarget: profile?.weeklyHoursTarget ?? 7,
      preferences: {
        favouriteModalities: prefs?.favouriteModalities ?? [],
        dislikedModalities: prefs?.dislikedModalities ?? [],
      },
      equipmentAvailable,
    },
    history,
    planned,
    readiness,
    pain,
    intents,
    availability,
    athleteModel: buildAthleteModel(learned, { meanWeeklyImpactIU, meanDailyLoadAU }),
    deload: deloadBlock
      ? {
          active: true,
          reason: deloadBlock.reason ?? undefined,
          until: deloadBlock.endsOn ?? undefined,
        }
      : null,
    events: eventRows.map((e) => ({
      kind: e.kind,
      date: e.date,
      priority: e.priority as "A" | "B" | "C",
      taperDays: e.taperDays,
      name: e.name,
    })),
    lastTestDates: Object.fromEntries(testRows.map((t) => [t.testKey, t.date])),
  };
}

function bandFromDeclared(
  energy: number,
  soreness: number,
  motivation: number,
  pain: boolean,
): ReadinessSnapshot["band"] {
  const signals =
    (energy === 1 ? 1 : 0) + (soreness >= 2 ? 1 : 0) + (motivation === 1 ? 1 : 0) + (pain ? 1 : 0);
  if (signals >= 2) return "poor";
  if (signals === 0 && energy >= 2 && soreness <= 1) return "good";
  return "ok";
}

/** Statuses the engine treats as "still planned" (a user move sets `auto_adjusted`, spec §53). */
export const ENGINE_PLANNED_STATUSES = ["planned", "in_progress", "auto_adjusted"] as const;

/** Rest is the absence of load: zero vector, no credits except the recovery credit an engine rest option may carry. */
function restLoadProfile(credits: LoadProfile["expectedCredits"]): LoadProfile {
  const kept: LoadProfile["expectedCredits"] = {};
  if (credits.mobility_recovery) kept.mobility_recovery = credits.mobility_recovery;
  return {
    expectedCredits: kept,
    loadVector: {
      cardiovascular: 0,
      muscular_lower: 0,
      muscular_upper: 0,
      impact: 0,
      eccentric: 0,
      technical: 0,
    },
    intensity: "easy",
    heavyStrength: false,
    durationMin: 0,
    modality: "other",
    patterns: {},
    impactUnits: 0,
  };
}

/**
 * Instant a done session ended, for residual-fatigue decay. `finished_at` is trusted only when it
 * falls on the session's own local day: late feedback or a back-dated log stamped with the feedback
 * time would otherwise make an old session look freshly finished. Fallback: start + duration, else
 * 17:00 UTC on the session's date (documented convention, ENGINE.md).
 */
function sessionEndTime(
  w: { date: IsoDate; startAt: Date | null; finishedAt: Date | null },
  durationMin: number,
  timezone: string,
): Date {
  if (w.finishedAt && localDate(w.finishedAt, timezone) <= w.date) return w.finishedAt;
  if (w.startAt) return new Date(w.startAt.getTime() + durationMin * 60000);
  return new Date(`${w.date}T17:00:00Z`);
}

export function modalityOfType(type: string): LoadProfile["modality"] {
  switch (type) {
    case "crossfit":
      return "mixed_modal";
    case "strength":
      return "strength";
    case "mobility":
      return "mobility";
    case "cardio":
      return "running";
    default:
      return "other";
  }
}

/** Workout kind/family are stored in notes-free columns: derive from template key or type. */
export function kindOf(w: { type: string; title: string }): string {
  if (w.type === "crossfit") return "crossfit";
  const t = w.title.toLowerCase();
  if (w.type === "strength")
    return t.includes("lower") || t.includes("bas")
      ? "strength_lower"
      : t.includes("upper") || t.includes("haut")
        ? "strength_upper"
        : t.includes("techn")
          ? "olympic_technique"
          : t.includes("skill") || t.includes("gym")
            ? "gymnastics_skill"
            : "strength_full";
  if (w.type === "cardio")
    return t.includes("vo2")
      ? "run_vo2"
      : t.includes("seuil") || t.includes("threshold")
        ? "run_threshold"
        : t.includes("long")
          ? "run_long_90"
          : t.includes("vélo") || t.includes("bike")
            ? "bike_easy_60"
            : t.includes("rameur") || t.includes("row")
              ? "row_easy_30"
              : "run_easy_45";
  if (w.type === "mobility") return "mobility_20";
  if (w.type === "rest") return "rest";
  return w.type;
}

export function familyOf(w: { type: string; title: string }): string {
  const k = kindOf(w);
  if (k === "crossfit") return "crossfit";
  if (k.startsWith("strength_")) return k;
  if (k.startsWith("run_easy") || k === "strides") return "run_easy";
  if (k.startsWith("run_long")) return "run_long";
  if (k.startsWith("run_")) return "run_hard";
  if (k.startsWith("bike_")) return "bike_easy";
  if (k.startsWith("row")) return "row";
  if (k === "mobility_20") return "mobility";
  if (k === "rest") return "rest";
  return k;
}

export const ENGINE_INPUT_ASSEMBLER_VERSION = "engine_input_v1" as const;
