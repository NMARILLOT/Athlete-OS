"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { INTENT_KIND_VALUES, INTENSITY_BAND_VALUES } from "@/domain/core";
import type { Option, Recommendation } from "@/domain/engine";
import { requireUser } from "@/server/auth";
import { acceptOption, recompute } from "@/server/services/recommendation.service";
import {
  declareIntent,
  declareReadiness,
  withdrawIntents,
} from "@/server/services/readiness.service";
import { createWorkoutFromOption } from "@/server/services/workout.service";
import { createStrengthWorkoutFromTemplate } from "@/server/services/strength-session.service";
import { localDate, localMinute } from "@/server/time";
import { aiProvider } from "@/server/providers/ai";
import { addDays } from "@/domain/core/dates";

const ReadinessInput = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  energy: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  soreness: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  motivation: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  unusualPain: z.boolean(),
});

export async function declareReadinessAction(input: z.infer<typeof ReadinessInput>): Promise<void> {
  const user = await requireUser();
  const parsed = ReadinessInput.parse(input);
  const db = await getDb();
  await declareReadiness(db, user.id, parsed);
  await recompute(db, user.id, { timezone: user.timezone, date: parsed.date });
  revalidatePath("/today");
}

const IntentInput = z.object({
  kind: z.enum(INTENT_KIND_VALUES),
  intensity: z.enum(INTENSITY_BAND_VALUES).optional(),
  availableMinutes: z.number().int().min(10).max(300).optional(),
});

/** Intent buttons: declare → inline recompute → return the new Recommendation for immediate render. */
export async function declareIntentAction(
  kind: string,
  intensity?: "easy" | "moderate" | "hard",
  availableMinutes?: number,
): Promise<Recommendation | null> {
  const user = await requireUser();
  const parsed = IntentInput.parse({ kind, intensity, availableMinutes });
  const db = await getDb();
  const today = localDate(new Date(), user.timezone);
  await declareIntent(db, user.id, {
    date: today,
    kind: parsed.kind,
    intensity: parsed.intensity ?? null,
    availableMinutes: parsed.availableMinutes ?? null,
    parsedBy: "USER",
  });
  const rec = await recompute(db, user.id, { timezone: user.timezone, date: today });
  revalidatePath("/today");
  revalidatePath("/calendar");
  return rec.output;
}

/** Free-text wish ("J'ai envie de courir") → bounded intent via the AI provider (mock = keywords). */
export async function declareFreeTextIntentAction(text: string): Promise<Recommendation | null> {
  const user = await requireUser();
  const clean = z.string().min(2).max(300).parse(text);
  const db = await getDb();
  const today = localDate(new Date(), user.timezone);
  const res = await aiProvider().parseIntent({ text: clean, today, tomorrow: addDays(today, 1) });
  const intent = res.output;
  await declareIntent(db, user.id, {
    date: intent.date ?? today,
    kind: intent.kind,
    intensity: intent.intensity ?? null,
    availableMinutes: intent.availableMinutes ?? null,
    rawText: clean,
    parsedBy: res.meta.provider === "anthropic" ? "AI_PARSED" : "USER",
  });
  const rec = await recompute(db, user.id, { timezone: user.timezone, date: today });
  revalidatePath("/today");
  return rec.output;
}

export async function clearIntentAction(): Promise<void> {
  const user = await requireUser();
  const db = await getDb();
  const today = localDate(new Date(), user.timezone);
  await withdrawIntents(db, user.id, today);
  await recompute(db, user.id, { timezone: user.timezone, date: today });
  revalidatePath("/today");
}

export async function acceptOptionAction(
  recommendationId: string | null,
  option: string,
): Promise<void> {
  const user = await requireUser();
  if (!recommendationId) return;
  const db = await getDb();
  await acceptOption(db, user.id, recommendationId, z.string().max(40).parse(option));
}

/** START: materialise the shown option as today's workout and route to the right mode. */
export async function startOptionAction(
  option: Option,
  recommendationId: string | null,
): Promise<{ href: string } | null> {
  const user = await requireUser();
  const db = await getDb();
  const now = new Date();
  const today = localDate(now, user.timezone);
  if (option.fixed && option.plannedId) {
    return {
      href:
        option.family === "crossfit"
          ? `/workouts/${option.plannedId}`
          : `/workouts/${option.plannedId}`,
    };
  }
  if (option.family === "rest") {
    await createWorkoutFromOption(db, user.id, {
      option,
      date: today,
      timezone: user.timezone,
      recommendationId,
    });
    await recompute(db, user.id, { timezone: user.timezone, date: today });
    revalidatePath("/today");
    return { href: "/today" };
  }
  const created = await createWorkoutFromOption(db, user.id, {
    option,
    date: today,
    timezone: user.timezone,
    recommendationId,
    startMinute: localMinute(now, user.timezone),
  });
  revalidatePath("/today");
  revalidatePath("/calendar");
  if (created.type === "strength") return { href: `/train/strength/${created.id}` };
  if (created.type === "cardio") return { href: `/train/cardio/${created.id}` };
  return { href: `/workouts/${created.id}` };
}

export async function startTemplateAction(templateId: string): Promise<{ href: string }> {
  const user = await requireUser();
  const db = await getDb();
  const today = localDate(new Date(), user.timezone);
  const { workoutId } = await createStrengthWorkoutFromTemplate(db, user.id, {
    templateId: z.string().max(40).parse(templateId),
    date: today,
  });
  revalidatePath("/today");
  return { href: `/train/strength/${workoutId}` };
}
