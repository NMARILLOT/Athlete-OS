import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { recommendations, workouts } from "@/db/schema";
import { ENGINE_VERSION, projectWeek, runEngine, type Recommendation } from "@/domain/engine";
import type { IsoDate } from "@/domain/core/dates";
import { log } from "@/server/logging";
import { localDate } from "@/server/time";
import { assembleEngineInput } from "./engine-input";
import { moveWorkout } from "./workout.service";

export interface StoredRecommendation {
  id: string;
  date: IsoDate;
  version: number;
  output: Recommendation;
  acceptedOption: string | null;
  computedAt: Date;
}

/**
 * Recompute today's recommendation (ARCHITECTURE §4): assemble input → runEngine → projectWeek →
 * persist one new version under a per-user advisory lock; previous versions are marked superseded.
 * Runs inline in the triggering action and is awaited before revalidation.
 */
export async function recompute(
  db: Db,
  userId: string,
  opts: { now?: Date; timezone: string; date?: IsoDate; projectDays?: number } = {
    timezone: "Europe/Paris",
  },
): Promise<StoredRecommendation> {
  const now = opts.now ?? new Date();
  const today = opts.date ?? localDate(now, opts.timezone);
  const started = Date.now();
  const input = await assembleEngineInput(db, userId, { now, timezone: opts.timezone, today });
  const output = runEngine(input);
  output.weekOutlook = projectWeek(input, opts.projectDays ?? 7);

  const stored = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}))`);
    const [latest] = await tx
      .select({ version: recommendations.version })
      .from(recommendations)
      .where(and(eq(recommendations.userId, userId), eq(recommendations.date, today)))
      .orderBy(desc(recommendations.version))
      .limit(1);
    await tx
      .update(recommendations)
      .set({ superseded: true })
      .where(
        and(
          eq(recommendations.userId, userId),
          eq(recommendations.date, today),
          eq(recommendations.superseded, false),
        ),
      );
    const [row] = await tx
      .insert(recommendations)
      .values({
        userId,
        date: today,
        version: (latest?.version ?? 0) + 1,
        engineVersion: ENGINE_VERSION,
        inputsSnapshot: input,
        output,
        rulesTriggered: [...new Set(output.rulesTriggered.map((h) => h.ruleId))],
        explanation: output.explanation,
        confidence: output.confidence.level,
        superseded: false,
      })
      .returning();
    if (!row) throw new Error("recommendation insert failed");
    return row;
  });
  log.info("recommendation.recomputed", {
    userId,
    date: today,
    durationMs: Date.now() - started,
    ruleIds: stored.rulesTriggered.slice(0, 8),
    version: String(stored.version),
  });
  return {
    id: stored.id,
    date: stored.date,
    version: stored.version,
    output: stored.output,
    acceptedOption: stored.acceptedOption,
    computedAt: stored.computedAt,
  };
}

export async function getCurrentRecommendation(
  db: Db,
  userId: string,
  date: IsoDate,
): Promise<StoredRecommendation | null> {
  const [row] = await db
    .select()
    .from(recommendations)
    .where(
      and(
        eq(recommendations.userId, userId),
        eq(recommendations.date, date),
        eq(recommendations.superseded, false),
      ),
    )
    .orderBy(desc(recommendations.version))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    date: row.date,
    version: row.version,
    output: row.output,
    acceptedOption: row.acceptedOption,
    computedAt: row.computedAt,
  };
}

/** One stored recommendation by id, user-scoped (null when it is not the user's). */
export async function getRecommendation(
  db: Db,
  userId: string,
  recommendationId: string,
): Promise<StoredRecommendation | null> {
  const [row] = await db
    .select()
    .from(recommendations)
    .where(and(eq(recommendations.userId, userId), eq(recommendations.id, recommendationId)))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    date: row.date,
    version: row.version,
    output: row.output,
    acceptedOption: row.acceptedOption,
    computedAt: row.computedAt,
  };
}

/**
 * The recommendation a START refers to: the client's id when that row is the user's and dated
 * `date` (a Today tab left open overnight still holds yesterday's id, whose options may no longer
 * exist), else the current one for `date`.
 */
export async function resolveRecommendation(
  db: Db,
  userId: string,
  opts: { recommendationId: string | null; date: IsoDate },
): Promise<StoredRecommendation | null> {
  const byId = opts.recommendationId
    ? await getRecommendation(db, userId, opts.recommendationId)
    : null;
  if (byId && byId.date === opts.date) return byId;
  return getCurrentRecommendation(db, userId, opts.date);
}

/** Idempotent fallback when the cron has not produced today's row (never the normal path). */
export async function ensureTodayRecommendation(
  db: Db,
  userId: string,
  timezone: string,
  now = new Date(),
): Promise<StoredRecommendation> {
  const today = localDate(now, timezone);
  const existing = await getCurrentRecommendation(db, userId, today);
  if (existing && existing.output.engineVersion === ENGINE_VERSION) return existing;
  return recompute(db, userId, { now, timezone, date: today });
}

export async function acceptOption(
  db: Db,
  userId: string,
  recommendationId: string,
  option: string,
): Promise<void> {
  await db
    .update(recommendations)
    .set({ acceptedOption: option })
    .where(and(eq(recommendations.userId, userId), eq(recommendations.id, recommendationId)));
}

export interface PendingReschedule {
  plannedId: string;
  title: string;
  fromDate: IsoDate;
  /** Null = no compatible day this week (the engine suggests skipping / next week). */
  toDate: IsoDate | null;
  reason: string;
}

/**
 * Engine reschedules (spec §32 "repositionner la force", §53 AUTO-ADJUSTED) still applicable: the
 * planned session is the user's, not fixed, still planned (`planned` / `auto_adjusted` — a session
 * already started is never listed nor moved, as the calendar's `checkMove` forbids it) and still on
 * `fromDate`. Today renders them as "Replanifié : <titre> → <date>" with an "Appliquer" action; the
 * engine never moves a workout by itself (ADR-017) — a reschedule is emitted whenever the planned
 * session is merely outscored.
 */
export async function pendingReschedules(
  db: Db,
  userId: string,
  rec: Recommendation,
): Promise<PendingReschedule[]> {
  const ids = [...new Set(rec.reschedules.map((r) => r.plannedId))];
  if (!ids.length) return [];
  const rows = await db
    .select({
      id: workouts.id,
      title: workouts.title,
      date: workouts.date,
      fixed: workouts.fixed,
      status: workouts.status,
    })
    .from(workouts)
    .where(and(eq(workouts.userId, userId), inArray(workouts.id, ids)));
  const open: ReadonlySet<string> = new Set(["planned", "auto_adjusted"]);
  return rec.reschedules.flatMap((r) => {
    const w = rows.find((x) => x.id === r.plannedId);
    if (!w || w.fixed || !open.has(w.status) || w.date !== r.fromDate) return [];
    return [
      { plannedId: w.id, title: w.title, fromDate: r.fromDate, toDate: r.toDate, reason: r.reason },
    ];
  });
}

/**
 * "Appliquer" on Today: move the suggested session(s) of today's current recommendation to the
 * engine's target date (status → `auto_adjusted`). Only reschedules with a target date on or after
 * today; the caller recomputes afterwards. `plannedIds` restricts the set (default: all).
 */
export async function applyReschedules(
  db: Db,
  userId: string,
  opts: { timezone: string; today: IsoDate; plannedIds?: string[] },
): Promise<{ applied: PendingReschedule[] }> {
  const rec = await getCurrentRecommendation(db, userId, opts.today);
  if (!rec) return { applied: [] };
  const applied: PendingReschedule[] = [];
  for (const r of await pendingReschedules(db, userId, rec.output)) {
    if (!r.toDate || r.toDate < opts.today || r.toDate === r.fromDate) continue;
    if (opts.plannedIds && !opts.plannedIds.includes(r.plannedId)) continue;
    await moveWorkout(db, userId, r.plannedId, r.toDate, opts.timezone);
    applied.push(r);
  }
  return { applied };
}
