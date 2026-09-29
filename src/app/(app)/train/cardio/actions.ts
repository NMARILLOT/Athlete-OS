"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { CARDIO_PRESET_KINDS, CardioWorkoutSpecSchema } from "@/domain/cardio";
import { FEELING_VALUES } from "@/domain/core";
import { clockToMinutes } from "@/domain/core/dates";
import { requireUser } from "@/server/auth";
import {
  completeCardio,
  createCardioWorkout,
  sendToGarmin,
  startCardioWorkout,
  updateCardioSpec,
  type CardioGarminView,
} from "@/server/services/cardio.service";
import { recompute } from "@/server/services/recommendation.service";

const IsoDateInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ClockInput = z.string().regex(/^\d{2}:\d{2}$/);
const WorkoutIdInput = z.string().uuid();

const CreateInput = z.object({
  date: IsoDateInput,
  start: ClockInput.nullable(),
  spec: CardioWorkoutSpecSchema,
  presetKind: z.enum(CARDIO_PRESET_KINDS).nullable().optional(),
});
export type CreateCardioInput = z.infer<typeof CreateInput>;

const CompleteInput = z.object({
  workoutId: WorkoutIdInput,
  rpe: z.number().min(1).max(10).nullable(),
  feeling: z.enum(FEELING_VALUES).nullable(),
  painReported: z.boolean(),
  notes: z.string().max(1000).optional(),
});
export type CompleteCardioInput = z.infer<typeof CompleteInput>;

function revalidateCardio(id: string): void {
  revalidatePath("/today");
  revalidatePath("/calendar");
  revalidatePath("/train");
  revalidatePath(`/train/cardio/${id}`);
  revalidatePath(`/workouts/${id}`);
}

/** "Créer la séance": planned workout + spec + analysis → inline recompute → the cardio page. */
export async function createCardioWorkoutAction(
  input: CreateCardioInput,
): Promise<{ href: string }> {
  const user = await requireUser();
  const parsed = CreateInput.parse(input);
  const db = await getDb();
  const { id } = await createCardioWorkout(db, user.id, {
    date: parsed.date,
    startMinute: parsed.start ? clockToMinutes(parsed.start) : null,
    timezone: user.timezone,
    spec: parsed.spec,
    presetKind: parsed.presetKind ?? null,
  });
  await recompute(db, user.id, { timezone: user.timezone });
  revalidateCardio(id);
  return { href: `/train/cardio/${id}` };
}

/** "Enregistrer les modifications" (planned workouts only): new spec → new planned analysis → recompute. */
export async function updateCardioSpecAction(
  workoutId: string,
  spec: CreateCardioInput["spec"],
): Promise<{ href: string }> {
  const user = await requireUser();
  const id = WorkoutIdInput.parse(workoutId);
  const parsedSpec = CardioWorkoutSpecSchema.parse(spec);
  const db = await getDb();
  await updateCardioSpec(db, user.id, id, parsedSpec);
  await recompute(db, user.id, { timezone: user.timezone });
  revalidateCardio(id);
  return { href: `/train/cardio/${id}` };
}

/** SEND TO GARMIN: the outcome (synced / pending / failed + message) is stored and returned. */
export async function sendToGarminAction(workoutId: string): Promise<CardioGarminView> {
  const user = await requireUser();
  const id = WorkoutIdInput.parse(workoutId);
  const db = await getDb();
  const garmin = await sendToGarmin(db, user.id, id);
  revalidatePath(`/train/cardio/${id}`);
  revalidatePath(`/workouts/${id}`);
  return garmin;
}

/** "Démarrer": in progress from now (no recompute — the plan does not change until it is done). */
export async function startCardioAction(workoutId: string): Promise<void> {
  const user = await requireUser();
  const id = WorkoutIdInput.parse(workoutId);
  const db = await getDb();
  await startCardioWorkout(db, user.id, id);
  revalidateCardio(id);
}

/** "Terminer" (spec §22): feedback → actual analysis → inline recompute → workout page. */
export async function completeCardioAction(input: CompleteCardioInput): Promise<{ href: string }> {
  const user = await requireUser();
  const parsed = CompleteInput.parse(input);
  const db = await getDb();
  await completeCardio(db, user.id, {
    workoutId: parsed.workoutId,
    rpe: parsed.rpe,
    feeling: parsed.feeling,
    painReported: parsed.painReported,
    notes: parsed.notes,
  });
  await recompute(db, user.id, { timezone: user.timezone });
  revalidateCardio(parsed.workoutId);
  return { href: `/workouts/${parsed.workoutId}` };
}
