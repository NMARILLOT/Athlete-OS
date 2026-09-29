import "server-only";
import { and, asc, desc, eq, inArray, max, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { personalRecords, strengthSets } from "@/db/schema";
import { addDays, isoWeekEnd, isoWeekStart, type IsoDate } from "@/domain/core/dates";
import { getExercise } from "@/domain/exercises";
import { NotFoundError } from "@/server/errors";
import type { ExercisePageView, StrengthSetView } from "./view-models";

/**
 * Exercise page (spec §28): current e1RM, PRs, last exposure, weekly sets, recent loads and the
 * set history of one movement. Every e1RM is an Epley estimate (the UI shows "≈"); PR values are
 * whatever `personal_records` stored, with their own `estimated` flag (spec §58, §70).
 */

/** Window for "current" e1RM: the best working-set estimate of the last 28 days. */
const CURRENT_E1RM_DAYS = 28;
const RECENT_LOADS = 20;
const HISTORY_WORKOUTS = 12;
/** Enough sets to cover the recent-load and current-e1RM windows of any realistic athlete. */
const SET_SCAN_LIMIT = 400;

function toSetView(s: typeof strengthSets.$inferSelect): StrengthSetView {
  return {
    id: s.id,
    setIndex: s.setIndex,
    reps: s.reps,
    weightKg: s.weightKg,
    rpe: s.rpe,
    quality: s.quality,
    isWarmup: s.isWarmup,
    completedAt: s.completedAt.toISOString(),
    e1rmKg: s.e1rmKg,
  };
}

/**
 * Build the page for one catalog exercise. Throws `NotFoundError` for an id outside the catalog;
 * an exercise the athlete never trained returns nulls, zeros and empty lists.
 */
export async function getExercisePage(
  db: Db,
  userId: string,
  exerciseId: string,
  today: IsoDate = new Date().toISOString().slice(0, 10),
): Promise<ExercisePageView> {
  const def = getExercise(exerciseId);
  if (!def) throw new NotFoundError("Exercice");

  const recent = await db
    .select()
    .from(strengthSets)
    .where(and(eq(strengthSets.userId, userId), eq(strengthSets.exerciseId, exerciseId)))
    .orderBy(desc(strengthSets.completedAt), desc(strengthSets.setIndex))
    .limit(SET_SCAN_LIMIT);
  const working = recent.filter((s) => !s.isWarmup);

  const currentFrom = addDays(today, -(CURRENT_E1RM_DAYS - 1));
  let currentE1rmKg: number | null = null;
  for (const s of working) {
    if (s.e1rmKg == null || s.date < currentFrom || s.date > today) continue;
    if (currentE1rmKg === null || s.e1rmKg > currentE1rmKg) currentE1rmKg = s.e1rmKg;
  }

  const weekStart = isoWeekStart(today);
  const weekEnd = isoWeekEnd(today);
  const weeklySets = working.filter((s) => s.date >= weekStart && s.date <= weekEnd).length;

  const lastExposure = working[0]?.date ?? null;

  const recentLoads = working
    .filter((s) => s.weightKg != null && s.reps != null)
    .slice(0, RECENT_LOADS)
    .reverse()
    .map((s) => ({
      date: s.date,
      weightKg: s.weightKg as number,
      reps: s.reps as number,
      e1rmKg: s.e1rmKg,
    }));

  // History: the last 12 workouts that contain this exercise, each with all its sets in order.
  const workoutRows = await db
    .select({ workoutId: strengthSets.workoutId, date: max(strengthSets.date) })
    .from(strengthSets)
    .where(and(eq(strengthSets.userId, userId), eq(strengthSets.exerciseId, exerciseId)))
    .groupBy(strengthSets.workoutId)
    .orderBy(desc(max(strengthSets.date)), desc(max(strengthSets.completedAt)))
    .limit(HISTORY_WORKOUTS);
  const workoutIds = workoutRows.map((r) => r.workoutId);
  const historySets = workoutIds.length
    ? await db
        .select()
        .from(strengthSets)
        .where(
          and(
            eq(strengthSets.userId, userId),
            eq(strengthSets.exerciseId, exerciseId),
            inArray(strengthSets.workoutId, workoutIds),
          ),
        )
        .orderBy(asc(strengthSets.completedAt), asc(strengthSets.setIndex))
    : [];
  const setsByWorkout = new Map<string, StrengthSetView[]>();
  for (const s of historySets)
    setsByWorkout.set(s.workoutId, [...(setsByWorkout.get(s.workoutId) ?? []), toSetView(s)]);
  const history = workoutRows.map((r) => ({
    date: r.date ?? setsByWorkout.get(r.workoutId)?.[0]?.completedAt.slice(0, 10) ?? today,
    workoutId: r.workoutId,
    sets: setsByWorkout.get(r.workoutId) ?? [],
  }));

  // PRs: latest current record for "recent", the all-time maximum (superseded included) for "best".
  const prRows = await db
    .select({
      value: personalRecords.value,
      unit: personalRecords.unit,
      superseded: personalRecords.superseded,
      achievedAt: personalRecords.achievedAt,
    })
    .from(personalRecords)
    .where(
      and(
        eq(personalRecords.userId, userId),
        eq(personalRecords.exerciseId, exerciseId),
        inArray(personalRecords.kind, ["e1rm", "weight"]),
        sql`lower(${personalRecords.unit}) = 'kg'`,
      ),
    )
    .orderBy(desc(personalRecords.achievedAt));
  const recentPrKg = prRows.find((r) => !r.superseded)?.value ?? null;
  const bestPrKg = prRows.reduce<number | null>(
    (best, r) => (best === null || r.value > best ? r.value : best),
    null,
  );

  return {
    exerciseId,
    name: def.name,
    currentE1rmKg,
    recentPrKg,
    bestPrKg,
    lastExposure,
    weeklySets,
    recentLoads,
    history,
  };
}
