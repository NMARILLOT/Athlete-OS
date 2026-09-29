"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { requireUser } from "@/server/auth";
import { AppError } from "@/server/errors";
import {
  checkMove,
  moveWorkoutChecked,
  planRestDay,
  type MoveCheck,
} from "@/server/services/calendar.service";
import { recompute } from "@/server/services/recommendation.service";

const IsoDateInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const MoveInput = z.object({ workoutId: z.string().uuid(), toDate: IsoDateInput });

/** Engine verdict for a candidate move (no write). */
export async function checkMoveAction(workoutId: string, toDate: string): Promise<MoveCheck> {
  const user = await requireUser();
  const input = MoveInput.parse({ workoutId, toDate });
  const db = await getDb();
  return checkMove(db, user, input.workoutId, input.toDate);
}

/**
 * Move after verification. `force` overrides an engine veto (the athlete decides, spec §53);
 * structurally blocked moves (fixed class, done, past) are refused whatever the flag.
 */
export async function moveWorkoutAction(
  workoutId: string,
  toDate: string,
  force: boolean,
): Promise<{ ok: true; check: MoveCheck } | { ok: false; message: string }> {
  const user = await requireUser();
  const input = MoveInput.extend({ force: z.boolean() }).parse({ workoutId, toDate, force });
  const db = await getDb();
  try {
    const check = await moveWorkoutChecked(db, user, input.workoutId, input.toDate, {
      force: input.force,
    });
    await recompute(db, user.id, { timezone: user.timezone });
    revalidatePath("/calendar");
    revalidatePath("/today");
    revalidatePath(`/workouts/${input.workoutId}`);
    return { ok: true, check };
  } catch (e) {
    if (e instanceof AppError) return { ok: false, message: e.message };
    throw e;
  }
}

/** "Repos" quick action on a day card: idempotent planned rest row, then recompute. */
export async function planRestDayAction(date: string): Promise<void> {
  const user = await requireUser();
  const day = IsoDateInput.parse(date);
  const db = await getDb();
  await planRestDay(db, user.id, day);
  await recompute(db, user.id, { timezone: user.timezone });
  revalidatePath("/calendar");
  revalidatePath("/today");
}
