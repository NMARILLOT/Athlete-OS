"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { addDays } from "@/domain/core/dates";
import { requireUser } from "@/server/auth";
import { FeatureDisabledError } from "@/server/flags";
import { errorFields, log } from "@/server/logging";
import { syncGarminActivities } from "@/server/services/activity.service";
import { recompute } from "@/server/services/recommendation.service";
import { localDate } from "@/server/time";

export type GarminSyncActionResult =
  | { ok: true; imported: number; duplicates: number; prs: string[] }
  | { ok: false; message: string };

const DaysInput = z.number().int().min(1).max(90);

/** "Synchroniser Garmin": pull the last N days (default 14) through the shared import pipeline. */
export async function syncGarminAction(days = 14): Promise<GarminSyncActionResult> {
  const user = await requireUser();
  const span = DaysInput.parse(days);
  const db = await getDb();
  const today = localDate(new Date(), user.timezone);
  try {
    const result = await syncGarminActivities(db, user, {
      from: `${addDays(today, -span)}T00:00:00Z`,
      to: `${today}T23:59:59Z`,
    });
    if (result.imported > 0) {
      await recompute(db, user.id, { timezone: user.timezone, date: today });
      revalidatePath("/today");
      revalidatePath("/calendar");
    }
    revalidatePath("/activities");
    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof FeatureDisabledError)
      return { ok: false, message: "Garmin : bientôt (API officielle en attente)." };
    log.error("activities.garmin_sync_failed", { userId: user.id, ...errorFields(err) });
    return { ok: false, message: "Synchronisation impossible pour le moment. Réessaie." };
  }
}
