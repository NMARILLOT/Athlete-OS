import "server-only";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { syncJobs, users } from "@/db/schema";
import { errorFields, log } from "@/server/logging";
import { recompute } from "@/server/services/recommendation.service";
import { localDate } from "@/server/time";

/**
 * Daily dispatcher (ARCHITECTURE §4): for every user, recompute today's recommendation (+ week
 * outlook), and process queued sync jobs with a lease. Evening/weekly tasks are folded in here.
 */
export async function runDailyJobs(
  db: Db,
  now: Date,
): Promise<{ users: number; recomputed: number; jobs: number }> {
  const all = await db.select({ id: users.id, timezone: users.timezone }).from(users);
  let recomputed = 0;
  let jobs = 0;
  for (const u of all) {
    try {
      await recompute(db, u.id, { now, timezone: u.timezone, date: localDate(now, u.timezone) });
      recomputed++;
    } catch (err) {
      log.warn("cron.recompute_failed", { userId: u.id, ...errorFields(err) });
    }
    jobs += await runJobsOnce(db, u.id, now);
  }
  return { users: all.length, recomputed, jobs };
}

/** Claim-and-run loop with SKIP LOCKED + lease (max 20 per user per run). */
export async function runJobsOnce(db: Db, userId: string, now = new Date()): Promise<number> {
  let processed = 0;
  // Requeue stale leases.
  await db
    .update(syncJobs)
    .set({ status: "queued", leasedUntil: null })
    .where(
      and(
        eq(syncJobs.userId, userId),
        eq(syncJobs.status, "running"),
        lt(syncJobs.leasedUntil, now),
      ),
    );
  for (let i = 0; i < 20; i++) {
    const claimed = await db.execute(sql`
      update sync_jobs set status = 'running', started_at = now(), attempts = attempts + 1, leased_until = now() + interval '5 minutes'
      where id = (select id from sync_jobs where user_id = ${userId} and status = 'queued' and run_after <= now() order by run_after limit 1 for update skip locked)
      returning id, kind, payload, attempts`);
    const row =
      (
        claimed as unknown as {
          rows?: Array<{ id: string; kind: string; payload: unknown; attempts: number }>;
        }
      ).rows?.[0] ??
      (Array.isArray(claimed)
        ? (claimed as Array<{ id: string; kind: string; payload: unknown; attempts: number }>)[0]
        : undefined);
    if (!row) break;
    try {
      await handleJob(db, userId, row.kind, row.payload);
      await db
        .update(syncJobs)
        .set({ status: "done", finishedAt: new Date(), leasedUntil: null })
        .where(eq(syncJobs.id, row.id));
    } catch (err) {
      const failed = row.attempts >= 5;
      await db
        .update(syncJobs)
        .set({
          status: failed ? "failed" : "queued",
          error: err instanceof Error ? err.name : "error",
          leasedUntil: null,
          runAfter: new Date(now.getTime() + Math.min(6 * 3600, 60 * 2 ** row.attempts) * 1000),
        })
        .where(eq(syncJobs.id, row.id));
      log.warn("job.failed", { userId, jobId: row.id, kind: row.kind, ...errorFields(err) });
    }
    processed++;
  }
  return processed;
}

async function handleJob(db: Db, userId: string, kind: string, _payload: unknown): Promise<void> {
  switch (kind) {
    case "recompute_recommendation": {
      const [u] = await db
        .select({ timezone: users.timezone })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      await recompute(db, userId, { timezone: u?.timezone ?? "Europe/Paris" });
      return;
    }
    default:
      // garmin_activities / garmin_health / bodycomp arrive with MVP 2 providers.
      log.info("job.noop", { userId, kind });
  }
}
