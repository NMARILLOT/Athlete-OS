"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { FEELING_VALUES } from "@/domain/core";
import { requireUser } from "@/server/auth";
import { recompute } from "@/server/services/recommendation.service";
import { completeWorkout, skipWorkout } from "@/server/services/workout.service";

const ScoreInput = z.object({
  kind: z.enum(["time", "rounds_reps", "reps", "load"]),
  /** Seconds (time), rounds (rounds_reps), reps or kg. */
  value: z.number().nonnegative().max(100_000),
  extraReps: z.number().int().nonnegative().max(10_000).nullable().optional(),
  rx: z.boolean(),
  scaledNotes: z.string().max(300).optional(),
});

const CompleteInput = z.object({
  workoutId: z.string().uuid(),
  rpe: z.number().min(1).max(10).nullable(),
  feeling: z.enum(FEELING_VALUES).nullable(),
  painReported: z.boolean(),
  notes: z.string().max(1000).optional(),
  actualDurationMin: z.number().int().min(1).max(600).nullable().optional(),
  score: ScoreInput.nullable().optional(),
});
export type CompleteWorkoutInput = z.infer<typeof CompleteInput>;

function revalidateWorkout(id: string): void {
  revalidatePath("/today");
  revalidatePath("/calendar");
  revalidatePath(`/workouts/${id}`);
}

/**
 * Post-session feedback (spec §22) for planned crossfit / free / mobility / coach sessions, and
 * "Modifier le ressenti" on done ones (`completeWorkout` upserts the actual analysis).
 */
export async function completeWorkoutAction(input: CompleteWorkoutInput): Promise<void> {
  const user = await requireUser();
  const parsed = CompleteInput.parse(input);
  const db = await getDb();
  const score = parsed.score
    ? {
        kind: parsed.score.kind,
        value: parsed.score.value,
        extraReps: parsed.score.extraReps ?? null,
        rx: parsed.score.rx,
        scaledNotes: parsed.score.scaledNotes?.trim() || undefined,
      }
    : null;
  await completeWorkout(db, user.id, {
    workoutId: parsed.workoutId,
    rpe: parsed.rpe,
    feeling: parsed.feeling,
    painReported: parsed.painReported,
    actualDurationMin: parsed.actualDurationMin ?? null,
    notes: parsed.notes,
    score,
  });
  await recompute(db, user.id, { timezone: user.timezone });
  revalidateWorkout(parsed.workoutId);
}

export async function skipWorkoutAction(workoutId: string): Promise<void> {
  const user = await requireUser();
  const id = z.string().uuid().parse(workoutId);
  const db = await getDb();
  await skipWorkout(db, user.id, id);
  await recompute(db, user.id, { timezone: user.timezone });
  revalidateWorkout(id);
}
