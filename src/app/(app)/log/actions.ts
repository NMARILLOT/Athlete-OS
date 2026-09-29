"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db/client";
import { FEELING_VALUES, INTENSITY_BAND_VALUES, PAIN_LOCATION_VALUES } from "@/domain/core";
import { clockToMinutes } from "@/domain/core/dates";
import { requireUser } from "@/server/auth";
import {
  DEMO_LEVEL_VALUES,
  logBodyComposition,
  logCoachSession,
  logRestDay,
} from "@/server/services/log.service";
import { logPain, resolvePain } from "@/server/services/readiness.service";
import { recompute } from "@/server/services/recommendation.service";
import { logQuickWorkout } from "@/server/services/workout.service";
import { instantFor } from "@/server/time";

const IsoDateInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ClockInput = z.string().regex(/^\d{2}:\d{2}$/);

const QuickWorkoutInput = z.object({
  date: IsoDateInput,
  type: z.enum(["cardio", "free", "mobility"]),
  /** Catalog kind (`run_easy_45`, …) or null for a free title. */
  kind: z.string().max(40).nullable(),
  title: z.string().trim().min(1).max(80),
  durationMin: z.number().int().min(5).max(300),
  intensity: z.enum(INTENSITY_BAND_VALUES),
  rpe: z.number().min(1).max(10).nullable(),
  feeling: z.enum(FEELING_VALUES).nullable(),
});
export type QuickWorkoutInput = z.infer<typeof QuickWorkoutInput>;

/** "+ Enregistrer une activité" → done workout → recompute → its detail page. */
export async function logQuickWorkoutAction(input: QuickWorkoutInput): Promise<void> {
  const user = await requireUser();
  const parsed = QuickWorkoutInput.parse(input);
  const db = await getDb();
  const created = await logQuickWorkout(db, user.id, {
    date: parsed.date,
    type: parsed.type,
    title: parsed.title,
    durationMin: parsed.durationMin,
    rpe: parsed.rpe,
    feeling: parsed.feeling,
    intensity: parsed.intensity,
    kind: parsed.kind,
    timezone: user.timezone,
  });
  await recompute(db, user.id, { timezone: user.timezone });
  revalidatePath("/today");
  revalidatePath("/calendar");
  revalidatePath("/progress");
  redirect(`/workouts/${created.id}`);
}

const CoachSessionInput = z.object({
  date: IsoDateInput,
  start: ClockInput.nullable(),
  durationMin: z.number().int().min(15).max(600),
  demoLevel: z.enum(DEMO_LEVEL_VALUES),
  standingMinutes: z.number().int().min(0).max(600),
  perceivedFatigue: z.number().int().min(1).max(5),
  notes: z.string().max(500).optional(),
});
export type CoachSessionInput = z.infer<typeof CoachSessionInput>;

/** "+ Coaching CrossFit" (spec §24) → done coach_session + small documented load → Today. */
export async function logCoachSessionAction(input: CoachSessionInput): Promise<void> {
  const user = await requireUser();
  const parsed = CoachSessionInput.parse(input);
  const db = await getDb();
  await logCoachSession(db, user.id, {
    date: parsed.date,
    startMinute: parsed.start ? clockToMinutes(parsed.start) : null,
    durationMin: parsed.durationMin,
    demoLevel: parsed.demoLevel,
    standingMinutes: parsed.standingMinutes,
    perceivedFatigue: parsed.perceivedFatigue,
    timezone: user.timezone,
    notes: parsed.notes,
  });
  await recompute(db, user.id, { timezone: user.timezone });
  revalidatePath("/today");
  revalidatePath("/calendar");
  redirect("/today");
}

/** "+ Jour de repos" → idempotent rest workout for that date → Today. */
export async function logRestDayAction(date: string): Promise<void> {
  const user = await requireUser();
  const parsed = IsoDateInput.parse(date);
  const db = await getDb();
  await logRestDay(db, user.id, { date: parsed });
  await recompute(db, user.id, { timezone: user.timezone });
  revalidatePath("/today");
  revalidatePath("/calendar");
  redirect("/today");
}

const PainInput = z.object({
  location: z.enum(PAIN_LOCATION_VALUES),
  side: z.enum(["left", "right", "both"]).nullable(),
  intensity: z.number().int().min(0).max(10),
  movementSpecific: z.boolean(),
  movements: z.array(z.string().trim().min(1).max(60)).max(12),
  sudden: z.boolean(),
  persistent: z.boolean(),
  notes: z.string().max(500).optional(),
});
export type PainInput = z.infer<typeof PainInput>;

/**
 * "+ Signaler une douleur" (spec §91–95). Returns whether a consultation is advisable so the page
 * can show a calm message; the engine's safety rules already reduce or replace loads.
 */
export async function logPainAction(
  input: PainInput,
): Promise<{ id: string; medicalAdvice: boolean }> {
  const user = await requireUser();
  const parsed = PainInput.parse(input);
  const db = await getDb();
  const result = await logPain(db, user.id, {
    location: parsed.location,
    side: parsed.side,
    intensity: parsed.intensity,
    movementSpecific: parsed.movementSpecific,
    movements: parsed.movementSpecific ? parsed.movements : [],
    sudden: parsed.sudden,
    persistent: parsed.persistent,
    notes: parsed.notes,
  });
  await recompute(db, user.id, { timezone: user.timezone });
  revalidatePath("/today");
  revalidatePath("/log/pain");
  return result;
}

export async function resolvePainAction(painId: string): Promise<void> {
  const user = await requireUser();
  const id = z.string().uuid().parse(painId);
  const db = await getDb();
  await resolvePain(db, user.id, id);
  await recompute(db, user.id, { timezone: user.timezone });
  revalidatePath("/today");
  revalidatePath("/log/pain");
}

const BodyInput = z.object({
  /** Athlete-local "YYYY-MM-DDTHH:MM" from a datetime-local input. */
  measuredLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  weightKg: z.number().min(20).max(300),
  bodyFatPct: z.number().min(1).max(70).nullable(),
  muscleMassKg: z.number().min(5).max(200).nullable(),
  waterPct: z.number().min(20).max(80).nullable(),
});
export type BodyInput = z.infer<typeof BodyInput>;

/** "+ Mesure corporelle" (spec §25): manual weigh-in; bodyweight is not an engine input, no recompute. */
export async function logBodyCompositionAction(input: BodyInput): Promise<void> {
  const user = await requireUser();
  const parsed = BodyInput.parse(input);
  const db = await getDb();
  const date = parsed.measuredLocal.slice(0, 10);
  const clock = parsed.measuredLocal.slice(11, 16);
  await logBodyComposition(db, user.id, {
    measuredAt: instantFor(date, clockToMinutes(clock), user.timezone),
    weightKg: parsed.weightKg,
    bodyFatPct: parsed.bodyFatPct,
    muscleMassKg: parsed.muscleMassKg,
    waterPct: parsed.waterPct,
    timezone: user.timezone,
  });
  revalidatePath("/log/body");
  revalidatePath("/profile");
  revalidatePath("/progress");
}
