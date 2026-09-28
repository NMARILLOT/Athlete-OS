import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { requireUser } from "@/server/auth";
import { UnauthorizedError } from "@/server/errors";
import { errorFields, log } from "@/server/logging";
import { recompute } from "@/server/services/recommendation.service";
import { applyStrengthEvents, OutboxEventSchema } from "@/server/services/strength-session.service";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({ events: z.array(OutboxEventSchema).min(1).max(200) });

/** Strength outbox sink (ARCHITECTURE §4): stable URL across deploys, idempotent, scoped to the user. */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = Body.parse(await req.json());
    const db = await getDb();
    const result = await applyStrengthEvents(db, user.id, body.events);
    if (result.finishedWorkoutIds.length) {
      try {
        await recompute(db, user.id, { timezone: user.timezone });
      } catch (err) {
        log.warn("sync.strength.recompute_failed", { userId: user.id, ...errorFields(err) });
      }
    }
    return NextResponse.json({ acknowledged: result.acknowledged });
  } catch (err) {
    if (err instanceof UnauthorizedError)
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (err instanceof z.ZodError)
      return NextResponse.json(
        { error: "invalid", issues: err.issues.slice(0, 5) },
        { status: 400 },
      );
    log.error("sync.strength.failed", errorFields(err));
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
