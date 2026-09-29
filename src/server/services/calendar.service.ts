import "server-only";
import { and, eq, gte, lte } from "drizzle-orm";
import type { Db } from "@/db/client";
import { workoutAnalyses, workouts } from "@/db/schema";
import type { Confidence, StimulusKey, WorkoutType } from "@/domain/core";
import { addDays, isIsoDate, isoWeekStart, type IsoDate } from "@/domain/core/dates";
import {
  checkPlacement,
  getCatalogEntry,
  isBonusOption,
  STIMULUS_LABEL_FR,
  type DayOutlook,
  type LoadProfile,
  type Option,
  type PlacementVerdict,
  type Recommendation,
} from "@/domain/engine";
import type { CurrentUser } from "@/server/auth/types";
import { NotFoundError, ValidationError } from "@/server/errors";
import { localDate } from "@/server/time";
import { assembleEngineInput, familyOf, kindOf, modalityOfType } from "./engine-input";
import { ensureTodayRecommendation, type StoredRecommendation } from "./recommendation.service";
import { toWorkoutCard } from "./today.service";
import type { CalendarDayView, CalendarWeekView, WorkoutCard } from "./view-models";
import { moveWorkout } from "./workout.service";

/**
 * Calendar (spec §53, ARCHITECTURE route map `/calendar`): the week is the union of the real
 * `workouts` rows and, for the days today..today+6, the engine outlook stored with today's
 * recommendation. A projection is only shown where nothing real already covers it; moving a
 * workout goes through `checkPlacement` so the engine can warn ("Heavy Legs" before a squat WOD).
 */

type WorkoutRow = typeof workouts.$inferSelect;

/** Week summary shown above the day cards. Engine numbers only exist for the week containing today. */
export interface WeekSummary {
  /** Sessions still to do (planned, in progress or replanned), rest days excluded. */
  planned: number;
  done: number;
  skipped: number;
  /** Minutes of done sessions (actual, else planned). */
  doneMinutes: number;
  /**
   * Hard sessions in the engine's rolling 6-day window vs the budget it still allows
   * (`trace.derived.hardDone6d` / `hardBudgetRemaining`). `fixedUpcoming` = hard fixed classes in
   * the next 3 days already reserved in that budget. Null outside the current week.
   */
  hard: { done: number; max: number; fixedUpcoming: number } | null;
  /** Largest projected stimulus gaps for the week, French labels, biggest first (max 3). */
  topGaps: Array<{ key: StimulusKey; label: string; projectedGap: number }>;
  deloadActive: boolean;
  /** Date of the recommendation the engine numbers come from (null = no engine data). */
  engineDate: IsoDate | null;
}

export interface CalendarDay extends CalendarDayView {
  /** One-line engine explanation for the projected day (null when nothing is projected). */
  outlookExplanation: string | null;
  outlookConfidence: Confidence | null;
  isPast: boolean;
}

export interface CalendarWeek extends CalendarWeekView {
  days: CalendarDay[];
  today: IsoDate;
  summary: WeekSummary;
}

export interface MoveCheck {
  workoutId: string;
  workoutTitle: string;
  fromDate: IsoDate;
  toDate: IsoDate;
  verdict: PlacementVerdict;
  /**
   * False when the move is structurally impossible (fixed class, already done, target in the
   * past): `force` never applies. True verdicts of kind `veto` are engine advice and can be forced.
   */
  movable: boolean;
}

const ACTIVE_STATUSES: ReadonlySet<WorkoutRow["status"]> = new Set([
  "planned",
  "in_progress",
  "auto_adjusted",
]);

// ---------------------------------------------------------------------------
// Week view
// ---------------------------------------------------------------------------

/**
 * One week (ISO Monday `weekStart`, any date in the week is normalised) with real workouts and,
 * for dates ≥ today inside today's outlook, the projected primary/bonus not already covered by a
 * real workout of the same type. Past weeks carry real workouts only.
 */
export async function getCalendarWeek(
  db: Db,
  user: CurrentUser,
  weekStart: IsoDate,
  now = new Date(),
): Promise<CalendarWeek> {
  if (!isIsoDate(weekStart)) throw new ValidationError("Semaine invalide");
  const start = isoWeekStart(weekStart);
  const end = addDays(start, 6);
  const today = localDate(now, user.timezone);

  const rows = await db
    .select()
    .from(workouts)
    .where(and(eq(workouts.userId, user.id), gte(workouts.date, start), lte(workouts.date, end)));

  // The outlook covers today..today+6; fetch it only when the week overlaps that range.
  const overlapsOutlook = end >= today && start <= addDays(today, 6);
  const rec: StoredRecommendation | null = overlapsOutlook
    ? await ensureTodayRecommendation(db, user.id, user.timezone, now)
    : null;
  const outlookByDate = new Map<IsoDate, DayOutlook>(
    (rec?.output.weekOutlook ?? []).map((d) => [d.date, d]),
  );

  const days: CalendarDay[] = [];
  for (let k = 0; k < 7; k++) {
    const date = addDays(start, k);
    const cards = rows
      .filter((w) => w.date === date)
      .map(cardOf(user.timezone))
      .sort(byStartMinute);
    const outlook = date >= today ? outlookByDate.get(date) : undefined;
    const merged = outlook ? mergeOutlook(outlook, cards) : EMPTY_OUTLOOK;
    days.push({
      date,
      workouts: cards,
      isToday: date === today,
      isPast: date < today,
      ...merged,
    });
  }

  const currentWeek = start <= today && today <= end;
  return {
    weekStart: start,
    days,
    weekOutlookDate: rec?.date ?? null,
    today,
    summary: buildSummary(rows, currentWeek && rec ? rec.output : null),
  };
}

type MergedOutlook = Pick<
  CalendarDay,
  "outlook" | "bonus" | "outlookExplanation" | "outlookConfidence"
>;

const EMPTY_OUTLOOK: MergedOutlook = {
  outlook: null,
  bonus: null,
  outlookExplanation: null,
  outlookConfidence: null,
};

function mergeOutlook(day: DayOutlook, cards: WorkoutCard[]): MergedOutlook {
  const active = cards.filter((c) => c.status !== "skipped");
  const primary = isCovered(day.primary, active) ? null : day.primary;
  const bonus =
    isBonusOption(day.bonus) && !isCovered(day.bonus, active)
      ? { kind: day.bonus.kind, title: day.bonus.title }
      : null;
  if (!primary && !bonus) return EMPTY_OUTLOOK;
  return {
    outlook: primary
      ? {
          kind: primary.kind,
          title: primary.title,
          intensity: primary.intensity,
          durationMin: primary.durationMin,
          family: primary.family,
        }
      : null,
    bonus,
    outlookExplanation: day.explanation || null,
    outlookConfidence: day.confidence,
  };
}

/**
 * A projection is covered when a real workout materialises it (same planned id, or the option is
 * itself a fixed class) or when a real session of the same type already sits on that day. A
 * projected rest is covered by any real session.
 */
function isCovered(option: Option, active: WorkoutCard[]): boolean {
  if (option.fixed) return true;
  if (option.plannedId && active.some((c) => c.id === option.plannedId)) return true;
  const type = typeOfFamily(option.family);
  if (type === "rest") return active.length > 0;
  return active.some((c) => c.type === type);
}

function buildSummary(rows: WorkoutRow[], rec: Recommendation | null): WeekSummary {
  const sessions = rows.filter((w) => w.type !== "rest");
  const done = sessions.filter((w) => w.status === "done");
  const d = rec?.trace.derived ?? null;
  return {
    planned: sessions.filter((w) => ACTIVE_STATUSES.has(w.status)).length,
    done: done.length,
    skipped: sessions.filter((w) => w.status === "skipped").length,
    doneMinutes: done.reduce((a, w) => a + (w.actualDurationMin ?? w.plannedDurationMin ?? 0), 0),
    hard: d
      ? {
          done: d.hardDone6d,
          max: Math.max(d.hardDone6d, d.hardDone6d + d.hardBudgetRemaining),
          fixedUpcoming: d.hardFixedNext3d,
        }
      : null,
    topGaps: (d?.topGaps ?? [])
      .filter((g) => g.projectedGap > 0)
      .slice(0, 3)
      .map((g) => ({
        key: g.key,
        label: STIMULUS_LABEL_FR[g.key],
        projectedGap: Math.round(g.projectedGap * 10) / 10,
      })),
    deloadActive: d?.deloadActive ?? false,
    engineDate: rec?.date ?? null,
  };
}

function cardOf(timezone: string): (w: WorkoutRow) => WorkoutCard {
  return (w) => ({ ...toWorkoutCard(w, timezone), kind: kindOf(w), family: familyOf(w) });
}

function byStartMinute(a: WorkoutCard, b: WorkoutCard): number {
  if (a.startMinute == null && b.startMinute == null) return a.title.localeCompare(b.title);
  if (a.startMinute == null) return 1;
  if (b.startMinute == null) return -1;
  return a.startMinute - b.startMinute;
}

// ---------------------------------------------------------------------------
// Move with verification (spec §53: a move generates an alert, it does not forbid)
// ---------------------------------------------------------------------------

/**
 * Engine verdict for moving `workoutId` to `toDate`. Fixed classes, finished sessions and moves
 * into the past are blocked before any engine call (`movable: false`). Otherwise the workout's
 * planned load profile is placed on `toDate` by `checkPlacement` with the workout removed from
 * its current slot.
 */
export async function checkMove(
  db: Db,
  user: CurrentUser,
  workoutId: string,
  toDate: IsoDate,
  now = new Date(),
): Promise<MoveCheck> {
  if (!isIsoDate(toDate)) throw new ValidationError("Date invalide");
  const w = await loadOwnedWorkout(db, user.id, workoutId);
  const today = localDate(now, user.timezone);
  const base = { workoutId: w.id, workoutTitle: w.title, fromDate: w.date, toDate };

  if (w.fixed)
    return {
      ...base,
      movable: false,
      verdict: blocked(
        toDate,
        "FIXED_SESSION",
        "Séance fixée (cours, coaching) : elle ne se déplace pas depuis le calendrier.",
      ),
    };
  if (w.status === "done" || w.status === "skipped" || w.status === "in_progress")
    return {
      ...base,
      movable: false,
      verdict: blocked(
        toDate,
        "NOT_PLANNED",
        w.status === "done"
          ? "Séance déjà faite : impossible de la déplacer."
          : w.status === "skipped"
            ? "Séance sautée : replanifie-la depuis la séance."
            : "Séance en cours : termine-la d'abord.",
      ),
    };
  if (toDate < today)
    return {
      ...base,
      movable: false,
      verdict: blocked(toDate, "PAST_DATE", "Impossible de déplacer une séance dans le passé."),
    };
  if (toDate === w.date)
    return {
      ...base,
      movable: true,
      verdict: { date: toDate, verdict: "ok", outcomes: [], summary: "Déjà prévue ce jour-là." },
    };

  const input = await assembleEngineInput(db, user.id, { now, timezone: user.timezone, today });
  input.planned = input.planned.filter((p) => p.id !== w.id);
  const profile = await plannedProfileOf(db, user.id, w);
  const verdict = checkPlacement(
    input,
    { ...profile, kind: kindOf(w), family: familyOf(w), title: w.title },
    toDate,
  );
  return { ...base, movable: true, verdict };
}

/**
 * Check then move. A blocked move always throws; an engine `veto` throws unless `force` is set
 * (the athlete decides, the engine only alerts). Returns the verdict for display.
 */
export async function moveWorkoutChecked(
  db: Db,
  user: CurrentUser,
  workoutId: string,
  toDate: IsoDate,
  opts: { force?: boolean; now?: Date } = {},
): Promise<MoveCheck> {
  const check = await checkMove(db, user, workoutId, toDate, opts.now);
  if (!check.movable) throw new ValidationError(check.verdict.summary);
  if (check.verdict.verdict === "veto" && !opts.force)
    throw new ValidationError(check.verdict.summary);
  if (check.toDate !== check.fromDate)
    await moveWorkout(db, user.id, workoutId, toDate, user.timezone);
  return check;
}

/** "Repos" quick action: one planned `rest` row per date, idempotent (rest carries no load). */
export async function planRestDay(
  db: Db,
  userId: string,
  date: IsoDate,
): Promise<{ id: string; created: boolean }> {
  if (!isIsoDate(date)) throw new ValidationError("Date invalide");
  const [existing] = await db
    .select({ id: workouts.id })
    .from(workouts)
    .where(and(eq(workouts.userId, userId), eq(workouts.date, date), eq(workouts.type, "rest")))
    .limit(1);
  if (existing) return { id: existing.id, created: false };
  const [w] = await db
    .insert(workouts)
    .values({
      userId,
      type: "rest",
      source: "manual",
      status: "planned",
      date,
      title: "Repos",
      plannedIntensity: "easy",
      intensitySource: "USER",
    })
    .returning({ id: workouts.id });
  if (!w) throw new Error("workout insert failed");
  return { id: w.id, created: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadOwnedWorkout(db: Db, userId: string, workoutId: string): Promise<WorkoutRow> {
  const [w] = await db
    .select()
    .from(workouts)
    .where(and(eq(workouts.id, workoutId), eq(workouts.userId, userId)))
    .limit(1);
  if (!w) throw new NotFoundError("Séance");
  return w;
}

function blocked(date: IsoDate, ruleId: string, message: string): PlacementVerdict {
  return {
    date,
    verdict: "veto",
    outcomes: [{ ruleId, kind: "safety", effect: "veto", message }],
    summary: message,
  };
}

/** Planned analysis row → LoadProfile; catalog prior by kind when absent; light generic otherwise. */
async function plannedProfileOf(db: Db, userId: string, w: WorkoutRow): Promise<LoadProfile> {
  const [a] = await db
    .select()
    .from(workoutAnalyses)
    .where(
      and(
        eq(workoutAnalyses.workoutId, w.id),
        eq(workoutAnalyses.userId, userId),
        eq(workoutAnalyses.phase, "planned"),
      ),
    )
    .limit(1);
  if (a)
    return {
      expectedCredits: a.stimulusCredits,
      loadVector: a.loadVector,
      intensity: a.intensity,
      heavyStrength: a.heavyStrength,
      durationMin: w.plannedDurationMin ?? 60,
      modality: modalityOfType(w.type),
      patterns: a.patternExposure,
      impactUnits: a.impactUnits,
    };
  const catalog = getCatalogEntry(kindOf(w));
  if (catalog)
    return {
      expectedCredits: catalog.expectedCredits,
      loadVector: catalog.loadVector,
      intensity: w.plannedIntensity ?? catalog.intensity,
      heavyStrength: catalog.heavyStrength ?? false,
      durationMin: w.plannedDurationMin ?? catalog.durationMin,
      modality: catalog.modality,
      patterns: catalog.patterns,
      impactUnits: catalog.impactUnits ?? 0,
    };
  return {
    expectedCredits: {},
    loadVector: {
      cardiovascular: 1,
      muscular_lower: 1,
      muscular_upper: 1,
      impact: 0,
      eccentric: 0,
      technical: 0,
    },
    intensity: w.plannedIntensity ?? "easy",
    heavyStrength: false,
    durationMin: w.plannedDurationMin ?? 30,
    modality: modalityOfType(w.type),
    patterns: {},
    impactUnits: 0,
  };
}

/** Workout type an engine option family materialises as (mirror of workout.service's private mapping). */
export function typeOfFamily(family: string): WorkoutType {
  if (family === "crossfit" || family === "partner" || family === "benchmark") return "crossfit";
  if (
    family.startsWith("strength") ||
    family === "accessory" ||
    family === "olympic" ||
    family === "gymnastics"
  )
    return "strength";
  if (family === "rest") return "rest";
  if (family === "mobility") return "mobility";
  if (family === "hyrox" || family === "just_move") return "free";
  return "cardio";
}
