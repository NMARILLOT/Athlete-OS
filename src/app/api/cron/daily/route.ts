import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { bearerFrom, secretMatches } from "@/server/auth/secret";
import { env } from "@/server/env";
import { errorFields, log } from "@/server/logging";
import { runDailyJobs } from "@/server/jobs/daily";

export const runtime = "nodejs";
export const maxDuration = 60;

/** The single Vercel Cron (ARCHITECTURE §4): fails closed when CRON_SECRET is unset. */
export async function GET(req: Request) {
  const provided = bearerFrom(req.headers.get("authorization"));
  if (!secretMatches(provided, env().CRON_SECRET))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const started = Date.now();
  try {
    const db = await getDb();
    const summary = await runDailyJobs(db, new Date());
    log.info("cron.daily.done", { durationMs: Date.now() - started, count: summary.users });
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    log.error("cron.daily.failed", errorFields(err));
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
