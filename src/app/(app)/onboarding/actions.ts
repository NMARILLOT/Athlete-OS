"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db/client";
import { EQUIPMENT_VALUES, MODALITY_VALUES } from "@/domain/core";
import type { GoalKey } from "@/domain/core";
import { requireUser } from "@/server/auth";
import {
  completeOnboarding,
  LONG_GOAL_KEYS,
  MEDIUM_GOAL_KEYS,
  ONBOARDING_PR_LIFTS,
  seedDeclaredPrs,
  setAvailability,
  setGoalWeights,
  setMediumGoals,
  upsertPreferences,
  upsertProfileBasics,
} from "@/server/services/profile.service";
import { recompute } from "@/server/services/recommendation.service";
import { localDate } from "@/server/time";
import type { Db } from "@/db/client";
import type { CurrentUser } from "@/server/auth";

/**
 * Onboarding actions (spec §89–90). Each step saves its own data idempotently then moves on;
 * the engine is only recomputed at the end, or on every step when the athlete re-runs the
 * onboarding after completion (their training data already feeds the engine).
 */

const CLOCK = /^\d{2}:\d{2}$/;

async function recomputeIfOnboarded(db: Db, user: CurrentUser): Promise<void> {
  if (!user.onboardingCompletedAt) return;
  await recompute(db, user.id, { timezone: user.timezone });
  revalidatePath("/today");
  revalidatePath("/calendar");
}

const GoalsInput = z.object({
  weights: z.record(z.string(), z.number().min(0).max(1)),
  medium: z.array(z.enum(MEDIUM_GOAL_KEYS)).max(MEDIUM_GOAL_KEYS.length),
});

export async function saveGoalsStepAction(input: z.infer<typeof GoalsInput>): Promise<void> {
  const user = await requireUser();
  const parsed = GoalsInput.parse(input);
  const longKeys = new Set<string>(LONG_GOAL_KEYS);
  const weights: Partial<Record<GoalKey, number>> = {};
  for (const [k, v] of Object.entries(parsed.weights)) {
    if (longKeys.has(k)) weights[k as GoalKey] = v;
  }
  const db = await getDb();
  await setGoalWeights(db, user.id, weights);
  await setMediumGoals(db, user.id, parsed.medium);
  await recomputeIfOnboarded(db, user);
  revalidatePath("/profile");
  redirect("/onboarding/2");
}

const SportsInput = z.object({
  favouriteModalities: z.array(z.enum(MODALITY_VALUES)).max(MODALITY_VALUES.length),
  facilities: z.object({
    crossfitBox: z.boolean(),
    gym: z.boolean(),
    home: z.boolean(),
  }),
  equipment: z.array(z.enum(EQUIPMENT_VALUES)).max(EQUIPMENT_VALUES.length),
  preferredTrainingTimes: z.object({
    crossfit: z.string().regex(CLOCK).nullable(),
    strength: z.string().regex(CLOCK).nullable(),
    cardio: z.string().regex(CLOCK).nullable(),
  }),
});

export async function saveSportsStepAction(input: z.infer<typeof SportsInput>): Promise<void> {
  const user = await requireUser();
  const parsed = SportsInput.parse(input);
  const db = await getDb();
  const times: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.preferredTrainingTimes)) if (v) times[k] = v;
  await upsertProfileBasics(db, user.id, {
    equipment: parsed.equipment,
    facilities: parsed.facilities,
    preferredTrainingTimes: times,
  });
  await upsertPreferences(db, user.id, { favouriteModalities: parsed.favouriteModalities });
  await recomputeIfOnboarded(db, user);
  revalidatePath("/profile");
  redirect("/onboarding/3");
}

const AvailabilityInput = z.object({
  weeklyHoursTarget: z.number().int().min(3).max(15),
  maxHardSessionsPerWeek: z.number().int().min(2).max(4),
  slots: z
    .array(
      z.object({
        weekday: z.number().int().min(0).max(6),
        startMinute: z.number().int().min(0).max(1439),
        endMinute: z.number().int().min(1).max(1440),
      }),
    )
    .max(21),
});

export async function saveAvailabilityStepAction(
  input: z.infer<typeof AvailabilityInput>,
): Promise<void> {
  const user = await requireUser();
  const parsed = AvailabilityInput.parse(input);
  const db = await getDb();
  await upsertProfileBasics(db, user.id, { weeklyHoursTarget: parsed.weeklyHoursTarget });
  await upsertPreferences(db, user.id, { maxHardSessionsPerWeek: parsed.maxHardSessionsPerWeek });
  await setAvailability(db, user.id, parsed.slots);
  await recomputeIfOnboarded(db, user);
  revalidatePath("/profile");
  redirect("/onboarding/4");
}

const hr = z.number().int().min(30).max(240).nullable();
const LevelInput = z.object({
  prs: z
    .array(
      z.object({
        exerciseId: z.enum(ONBOARDING_PR_LIFTS),
        weightKg: z.number().positive().max(500),
      }),
    )
    .max(ONBOARDING_PR_LIFTS.length),
  lthrManual: hr,
  maxHrManual: hr,
  restingHrManual: hr,
  bodyweightKg: z.number().min(30).max(250).nullable(),
});

export async function saveLevelStepAction(input: z.infer<typeof LevelInput>): Promise<void> {
  const user = await requireUser();
  const parsed = LevelInput.parse(input);
  const db = await getDb();
  await seedDeclaredPrs(db, user.id, parsed.prs);
  await upsertProfileBasics(db, user.id, {
    lthrManual: parsed.lthrManual,
    maxHrManual: parsed.maxHrManual,
    restingHrManual: parsed.restingHrManual,
    bodyweightKg: parsed.bodyweightKg,
  });
  await recomputeIfOnboarded(db, user);
  revalidatePath("/profile");
  redirect("/onboarding/5");
}

/** "Terminer" (and "Passer" on the last step): complete → recompute → Today. */
export async function finishOnboardingAction(): Promise<void> {
  const user = await requireUser();
  const db = await getDb();
  const today = localDate(new Date(), user.timezone);
  await completeOnboarding(db, user.id, today);
  await recompute(db, user.id, { timezone: user.timezone, date: today });
  revalidatePath("/today");
  revalidatePath("/calendar");
  revalidatePath("/profile");
  redirect("/today");
}
