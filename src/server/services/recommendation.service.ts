import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { recommendations } from "@/db/schema";
import { ENGINE_VERSION, projectWeek, runEngine, type Recommendation } from "@/domain/engine";
import type { IsoDate } from "@/domain/core/dates";
import { log } from "@/server/logging";
import { localDate } from "@/server/time";
import { assembleEngineInput } from "./engine-input";

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
