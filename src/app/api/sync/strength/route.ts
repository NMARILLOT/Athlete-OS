import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { requireUser } from "@/server/auth";
import { httpError } from "@/server/http";
import { errorFields, log } from "@/server/logging";
import { recompute } from "@/server/services/recommendation.service";
import {
  applyStrengthEvents,
  OutboxEventSchema,
  type OutboxEventInput,
} from "@/server/services/strength-session.service";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({ events: z.array(z.unknown()).min(1).max(200) });

/**
 * Strength outbox sink (ARCHITECTURE §4): stable URL across deploys, idempotent, scoped to the user.
 * Events are validated one by one: a malformed element is acknowledged (so the client prunes it)
 * and logged instead of rejecting the whole batch — one poison event must never block the outbox.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = Body.parse(await req.json());
    const valid: OutboxEventInput[] = [];
    const dropped: string[] = [];
    for (const raw of body.events) {
      const parsed = OutboxEventSchema.safeParse(raw);
      if (parsed.success) {
        valid.push(parsed.data);
        continue;
      }
      const id = (raw as { id?: unknown } | null)?.id;
      if (typeof id === "string" && id.length <= 64) dropped.push(id);
      log.warn("sync.strength.invalid_event", {
        userId: user.id,
        count: parsed.error.issues.length,
      });
    }
    const db = await getDb();
    const result = valid.length
      ? await applyStrengthEvents(db, user.id, valid)
      : { acknowledged: [], finishedWorkoutIds: [] };
    if (result.finishedWorkoutIds.length) {
      try {
        await recompute(db, user.id, { timezone: user.timezone });
      } catch (err) {
        log.warn("sync.strength.recompute_failed", { userId: user.id, ...errorFields(err) });
      }
    }
    return NextResponse.json({ acknowledged: [...result.acknowledged, ...dropped] });
  } catch (err) {
    // 401 / 403 (allow-list) / 422 … and Zod body errors (400) answer with their own status.
    const mapped = httpError(err);
    if (mapped) return NextResponse.json(mapped.body, { status: mapped.status });
    log.error("sync.strength.failed", errorFields(err));
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
