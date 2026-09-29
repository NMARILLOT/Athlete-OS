"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db/client";
import { MODALITY_VALUES } from "@/domain/core";
import type { GoalKey } from "@/domain/core";
import { requireUser } from "@/server/auth";
import { deleteAuthUser } from "@/server/auth/admin";
import { supabaseServerClient } from "@/server/auth/supabase";
import { env } from "@/server/env";
import { NotConfiguredError } from "@/server/errors";
import { log } from "@/server/logging";
import {
  deleteUserData,
  endDeload,
  exportUserData,
  LONG_GOAL_KEYS,
  MEDIUM_GOAL_KEYS,
  setFocusBlock,
  setGoalWeights,
  setMediumGoals,
  startDeload,
  updateIdentity,
  upsertPreferences,
  upsertProfileBasics,
  type UserDataExport,
} from "@/server/services/profile.service";
import { resolvePain } from "@/server/services/readiness.service";
import { recompute } from "@/server/services/recommendation.service";
import { localDate } from "@/server/time";

/** Profile actions (spec §34–36, §71). Every training-relevant change recomputes the engine inline. */

const PROFILE_PATHS = ["/profile", "/profile/goals", "/today", "/calendar"] as const;
function revalidateProfile(): void {
  for (const p of PROFILE_PATHS) revalidatePath(p);
}

const IdentityInput = z.object({
  displayName: z.string().max(80),
  timezone: z.string().min(1).max(64),
});

export async function updateIdentityAction(input: z.infer<typeof IdentityInput>): Promise<void> {
  const user = await requireUser();
  const parsed = IdentityInput.parse(input);
  const db = await getDb();
  await updateIdentity(db, user.id, parsed);
  // A timezone change moves "today": recompute with the new clock.
  if (parsed.timezone !== user.timezone)
    await recompute(db, user.id, { timezone: parsed.timezone });
  revalidateProfile();
}

const PreferencesInput = z.object({
  barbellIncrementKg: z.number().min(0.5).max(20),
  dumbbellIncrementKg: z.number().min(0.5).max(20),
  machineIncrementKg: z.number().min(0.5).max(20),
  maxHardSessionsPerWeek: z.number().int().min(1).max(5),
  weeklyHoursTarget: z.number().int().min(1).max(20),
  favouriteModalities: z.array(z.enum(MODALITY_VALUES)).max(MODALITY_VALUES.length),
  dislikedModalities: z.array(z.enum(MODALITY_VALUES)).max(MODALITY_VALUES.length),
});

export async function updatePreferencesAction(
  input: z.infer<typeof PreferencesInput>,
): Promise<void> {
  const user = await requireUser();
  const parsed = PreferencesInput.parse(input);
  const db = await getDb();
  await upsertPreferences(db, user.id, {
    barbellIncrementKg: parsed.barbellIncrementKg,
    dumbbellIncrementKg: parsed.dumbbellIncrementKg,
    machineIncrementKg: parsed.machineIncrementKg,
    maxHardSessionsPerWeek: parsed.maxHardSessionsPerWeek,
    favouriteModalities: parsed.favouriteModalities,
    dislikedModalities: parsed.dislikedModalities.filter(
      (m) => !parsed.favouriteModalities.includes(m),
    ),
  });
  await upsertProfileBasics(db, user.id, { weeklyHoursTarget: parsed.weeklyHoursTarget });
  await recompute(db, user.id, { timezone: user.timezone });
  revalidateProfile();
}

const GoalsInput = z.object({
  weights: z.record(z.string(), z.number().min(0).max(1)),
  medium: z.array(z.enum(MEDIUM_GOAL_KEYS)).max(MEDIUM_GOAL_KEYS.length),
});

export async function updateGoalsAction(input: z.infer<typeof GoalsInput>): Promise<void> {
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
  await recompute(db, user.id, { timezone: user.timezone });
  revalidateProfile();
  redirect("/profile");
}

const DeloadInput = z.object({
  days: z.number().int().min(3).max(14).default(7),
  reason: z.string().max(200).default(""),
});

export async function startDeloadAction(input: z.infer<typeof DeloadInput>): Promise<void> {
  const user = await requireUser();
  const parsed = DeloadInput.parse(input);
  const db = await getDb();
  const today = localDate(new Date(), user.timezone);
  await startDeload(db, user.id, { today, days: parsed.days, reason: parsed.reason });
  await recompute(db, user.id, { timezone: user.timezone, date: today });
  revalidateProfile();
}

export async function endDeloadAction(): Promise<void> {
  const user = await requireUser();
  const db = await getDb();
  const today = localDate(new Date(), user.timezone);
  await endDeload(db, user.id, today);
  await recompute(db, user.id, { timezone: user.timezone, date: today });
  revalidateProfile();
}

const FocusInput = z.object({
  focus: z.enum(["base", "build", "performance", "custom"]),
  name: z.string().max(80).default(""),
});

export async function setFocusAction(input: z.infer<typeof FocusInput>): Promise<void> {
  const user = await requireUser();
  const parsed = FocusInput.parse(input);
  const db = await getDb();
  const today = localDate(new Date(), user.timezone);
  await setFocusBlock(db, user.id, { focus: parsed.focus, name: parsed.name, today });
  await recompute(db, user.id, { timezone: user.timezone, date: today });
  revalidateProfile();
}

export async function resolvePainAction(painId: string): Promise<void> {
  const user = await requireUser();
  const db = await getDb();
  await resolvePain(db, user.id, z.string().uuid().parse(painId));
  await recompute(db, user.id, { timezone: user.timezone });
  revalidateProfile();
}

/** Export: the JSON object is returned to the client, which downloads it as a file (spec §71). */
export async function exportDataAction(): Promise<UserDataExport> {
  const user = await requireUser();
  const db = await getDb();
  return exportUserData(db, user.id);
}

/**
 * Delete the account: the users row (everything cascades), then the auth user when the service
 * role is configured, then the session. The confirmation word is checked server-side too.
 */
export async function deleteAccountAction(confirmation: string): Promise<void> {
  const user = await requireUser();
  if (z.string().parse(confirmation).trim().toUpperCase() !== "SUPPRIMER")
    throw new Error("Confirmation invalide");
  const db = await getDb();
  await deleteUserData(db, user.id);
  const e = env();
  if (e.AUTH_MODE === "supabase") {
    try {
      await deleteAuthUser(user.id);
    } catch (err) {
      if (!(err instanceof NotConfiguredError)) throw err;
      log.warn("privacy.auth_delete_skipped", { userId: user.id, errorCode: err.code });
    }
    const supabase = await supabaseServerClient();
    await supabase.auth.signOut();
  }
  redirect("/login");
}

export async function signOutAction(): Promise<void> {
  await requireUser();
  if (env().AUTH_MODE === "supabase") {
    const supabase = await supabaseServerClient();
    await supabase.auth.signOut();
  }
  redirect("/login");
}
