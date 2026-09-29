"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { INTENT_KIND_VALUES, INTENSITY_BAND_VALUES, type UserIntent } from "@/domain/core";
import type { Option, Recommendation } from "@/domain/engine";
import { isBonusOption } from "@/domain/engine";
import { requireUser } from "@/server/auth";
import { ValidationError } from "@/server/errors";
import { AiCapExceededError, parseIntentGuarded } from "@/server/services/ai-invocations.service";
import { logRestDay } from "@/server/services/log.service";
import {
  acceptOption,
  applyReschedules,
  recompute,
  resolveRecommendation,
} from "@/server/services/recommendation.service";
import {
  declareIntent,
  declareReadiness,
  withdrawIntents,
} from "@/server/services/readiness.service";
import {
  createWorkoutFromOption,
  findOpenWorkoutForOption,
  optionFromCatalog,
  routeForWorkout,
} from "@/server/services/workout.service";
import { createStrengthWorkoutFromTemplate } from "@/server/services/strength-session.service";
import { localDate, localMinute } from "@/server/time";
import { heuristicIntent } from "@/server/providers/ai";
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

/**
 * Free-text wish ("J'ai envie de courir") → bounded intent via the AI provider (mock = keywords).
 * Goes through the invocation budget (reuse + daily cap + audit); over the cap, the keyword parser
 * answers instead of the model.
 */
export async function declareFreeTextIntentAction(text: string): Promise<Recommendation | null> {
  const user = await requireUser();
  const clean = z.string().min(2).max(300).parse(text);
  const db = await getDb();
  const today = localDate(new Date(), user.timezone);
  const tomorrow = addDays(today, 1);
  let intent: UserIntent;
  let parsedBy: "USER" | "AI_PARSED" = "USER";
  try {
    const res = await parseIntentGuarded(db, user.id, { text: clean, today, tomorrow });
    intent = res.output;
    parsedBy = res.meta.provider === "anthropic" ? "AI_PARSED" : "USER";
  } catch (err) {
    if (!(err instanceof AiCapExceededError)) throw err;
    intent = heuristicIntent(clean, today, tomorrow);
  }
  await declareIntent(db, user.id, {
    date: intent.date ?? today,
    kind: intent.kind,
    intensity: intent.intensity ?? null,
    availableMinutes: intent.availableMinutes ?? null,
    rawText: clean,
    parsedBy,
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

const RecommendationIdInput = z.string().uuid().nullable();
const SelectorInput = z
  .string()
  .max(40)
  .regex(/^(primary|alternative:\d{1,2}|bonus)$/);

export async function acceptOptionAction(
  recommendationId: string | null,
  option: string,
): Promise<void> {
  const user = await requireUser();
  const id = RecommendationIdInput.parse(recommendationId);
  const selector = SelectorInput.parse(option);
  if (!id) return;
  const db = await getDb();
  await acceptOption(db, user.id, id, selector);
}

/** Only the option's identity is taken from the client; its profile is resolved server-side. */
const OptionSelectorInput = z.object({
  kind: z.string().min(1).max(60),
  family: z.string().min(1).max(40),
  plannedId: z.string().uuid().optional(),
  fixed: z.boolean().optional(),
});

/**
 * START: open the session already planned for today when the option refers to one (a planned
 * session is never duplicated), else materialise the option as today's workout from the stored
 * recommendation (or the candidate catalog — never the client's numbers) and route to the mode.
 */
export async function startOptionAction(
  option: Option,
  recommendationId: string | null,
): Promise<{ href: string } | null> {
  const user = await requireUser();
  const sel = OptionSelectorInput.parse(option);
  const recId = RecommendationIdInput.parse(recommendationId);
  const db = await getDb();
  const now = new Date();
  const today = localDate(now, user.timezone);

  const open = await findOpenWorkoutForOption(db, user.id, {
    date: today,
    kind: sel.kind,
    plannedId: sel.plannedId ?? null,
  });
  if (open && open.type === "rest") {
    // A planned rest day (calendar "Repos") is simply marked done.
    await logRestDay(db, user.id, { date: today });
    await recompute(db, user.id, { timezone: user.timezone, date: today });
    revalidatePath("/today");
    return { href: "/today" };
  }
  if (open) {
    revalidatePath("/today");
    return { href: routeForWorkout(open) };
  }
  if (sel.plannedId || sel.fixed)
    throw new ValidationError("Cette séance n'est plus prévue aujourd'hui : recharge la page.");

  // The client's id is honoured only when its row is today's (a tab left open overnight sends
  // yesterday's); otherwise today's current recommendation resolves the option.
  const rec = await resolveRecommendation(db, user.id, { recommendationId: recId, date: today });
  const fromRec = rec
    ? [
        rec.output.primary,
        ...rec.output.alternatives,
        ...(isBonusOption(rec.output.bonus) ? [rec.output.bonus] : []),
      ].find((o) => o.kind === sel.kind && !o.plannedId)
    : undefined;
  const resolved = fromRec ?? optionFromCatalog(sel.kind);
  if (!resolved) throw new ValidationError("Option inconnue : recharge la page.");
  const storedRecommendationId = rec?.id ?? null;

  if (resolved.family === "rest") {
    await createWorkoutFromOption(db, user.id, {
      option: resolved,
      date: today,
      timezone: user.timezone,
      recommendationId: storedRecommendationId,
    });
    await recompute(db, user.id, { timezone: user.timezone, date: today });
    revalidatePath("/today");
    return { href: "/today" };
  }
  const created = await createWorkoutFromOption(db, user.id, {
    option: resolved,
    date: today,
    timezone: user.timezone,
    recommendationId: storedRecommendationId,
    startMinute: localMinute(now, user.timezone),
  });
  revalidatePath("/today");
  revalidatePath("/calendar");
  return { href: routeForWorkout(created) };
}

/**
 * "Appliquer" on a Today reschedule card: move the engine-suggested planned session(s) to their
 * target date (one id, or every pending reschedule), then recompute.
 */
export async function applyReschedulesAction(plannedId?: string): Promise<{ applied: number }> {
  const user = await requireUser();
  const id = z.string().uuid().optional().parse(plannedId);
  const db = await getDb();
  const today = localDate(new Date(), user.timezone);
  const { applied } = await applyReschedules(db, user.id, {
    timezone: user.timezone,
    today,
    plannedIds: id ? [id] : undefined,
  });
  if (applied.length) await recompute(db, user.id, { timezone: user.timezone, date: today });
  revalidatePath("/today");
  revalidatePath("/calendar");
  return { applied: applied.length };
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
