import "server-only";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { dailyReadiness, userIntents, users, athleteProfiles, workouts } from "@/db/schema";
import { addDays } from "@/domain/core/dates";
import type { CurrentUser } from "@/server/auth/types";
import { localDate, localMinute } from "@/server/time";
import { familyOf, kindOf } from "./engine-input";
import { ensureTodayRecommendation } from "./recommendation.service";
import type { TodayView, WorkoutCard } from "./view-models";

export function toWorkoutCard(w: typeof workouts.$inferSelect, timezone: string): WorkoutCard {
  return {
    id: w.id,
    date: w.date,
    type: w.type,
    status: w.status,
    title: w.title,
    kind: kindOf(w),
    family: familyOf(w),
    startMinute: w.startAt ? localMinute(w.startAt, timezone) : null,
    durationMin: w.actualDurationMin ?? w.plannedDurationMin,
    intensity: w.realisedIntensity ?? w.plannedIntensity,
    fixed: w.fixed,
    rpe: w.rpe,
    feeling: w.feeling,
    source: w.source,
  };
}

/** One query bundle for the Today screen (ARCHITECTURE §4). */
export async function getTodayView(
  db: Db,
  user: CurrentUser,
  now = new Date(),
): Promise<TodayView> {
  const today = localDate(now, user.timezone);
  const rec = await ensureTodayRecommendation(db, user.id, user.timezone, now);
  const rows = await db
    .select()
    .from(workouts)
    .where(and(eq(workouts.userId, user.id), eq(workouts.date, today)))
    .orderBy(workouts.startAt);
  const [readiness] = await db
    .select()
    .from(dailyReadiness)
    .where(and(eq(dailyReadiness.userId, user.id), eq(dailyReadiness.date, today)))
    .limit(1);
  const [intent] = await db
    .select()
    .from(userIntents)
    .where(
      and(
        eq(userIntents.userId, user.id),
        eq(userIntents.status, "active"),
        eq(userIntents.startsOn, today),
      ),
    )
    .orderBy(desc(userIntents.declaredAt))
    .limit(1);
  const [inProgress] = await db
    .select({ id: workouts.id, type: workouts.type })
    .from(workouts)
    .where(
      and(
        eq(workouts.userId, user.id),
        eq(workouts.status, "in_progress"),
        inArray(workouts.type, ["strength", "cardio"]),
        gte(workouts.date, addDays(today, -1)),
      ),
    )
    .orderBy(desc(workouts.startAt))
    .limit(1);
  const [profile] = await db
    .select({ baselinePhaseUntil: athleteProfiles.baselinePhaseUntil })
    .from(athleteProfiles)
    .where(eq(athleteProfiles.userId, user.id))
    .limit(1);
  const [u] = await db
    .select({ displayName: users.displayName, onboardingCompletedAt: users.onboardingCompletedAt })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);

  const insight = buildInsight(rec.output);
  return {
    date: today,
    displayName: u?.displayName || null,
    baselinePhase: profile?.baselinePhaseUntil
      ? profile.baselinePhaseUntil >= today
      : rec.output.trace.derived.readinessBand === "unknown" &&
        rec.output.confidence.level === "LOW",
    recommendation: rec.output,
    recommendationId: rec.id,
    workouts: rows.map((w) => toWorkoutCard(w, user.timezone)),
    readiness:
      readiness && readiness.energy != null
        ? {
            date: readiness.date,
            energy: readiness.energy,
            soreness: readiness.soreness ?? 0,
            motivation: readiness.motivation ?? 2,
            unusualPain: readiness.unusualPain,
          }
        : null,
    activeIntentKind: intent?.kind ?? null,
    inProgressWorkoutId: inProgress?.id ?? null,
    inProgressWorkoutType:
      inProgress?.type === "cardio" ? "cardio" : inProgress ? "strength" : null,
    insight,
    onboardingDone: Boolean(u?.onboardingCompletedAt),
  };
}

function buildInsight(rec: TodayView["recommendation"]): string | null {
  if (!rec) return null;
  const d = rec.trace.derived;
  if (d.hardBudgetRemaining <= 0)
    return "Budget de séances dures atteint pour la semaine : le reste sera facile ou technique.";
  const top = d.topGaps[0];
  if (top && top.projectedGap >= 1.5)
    return `Cette semaine il manque surtout : ${top.key.replace(/_/g, " ")}.`;
  if (d.consecutiveTrainingDays >= 5)
    return `${d.consecutiveTrainingDays} jours d'affilée : pense à une vraie journée de récupération.`;
  return null;
}
