"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db/client";
import { requireUser } from "@/server/auth";
import {
  confirmInboxItem,
  createInboxItem,
  discardInboxItem,
  parseInboxItem,
  updateInboxText,
} from "@/server/services/inbox.service";
import { recompute } from "@/server/services/recommendation.service";
import { localDate } from "@/server/time";
import { clockToMinutes } from "@/domain/core/dates";

const CreateInput = z.object({
  text: z.string().min(3).max(8000),
  scheduledFor: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  startLocal: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
});

/** Save raw text first, then parse (AI or heuristic), then go to the confirm screen. */
export async function createAndParseInboxAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const input = CreateInput.parse({
    text: String(formData.get("text") ?? ""),
    scheduledFor: formData.get("for") ? String(formData.get("for")) : undefined,
    startLocal: formData.get("start") ? String(formData.get("start")) : undefined,
  });
  const db = await getDb();
  const item = await createInboxItem(db, user.id, {
    text: input.text,
    inputKind: "paste",
    scheduledFor: input.scheduledFor ?? null,
    startLocal: input.startLocal ?? null,
  });
  await parseInboxItem(db, user.id, item.id);
  revalidatePath("/inbox");
  redirect(`/inbox/${item.id}`);
}

export async function reparseInboxAction(itemId: string, text: string): Promise<void> {
  const user = await requireUser();
  const db = await getDb();
  await updateInboxText(
    db,
    user.id,
    z.string().uuid().parse(itemId),
    z.string().min(3).max(8000).parse(text),
  );
  revalidatePath(`/inbox/${itemId}`);
}

const ConfirmInput = z.object({
  itemId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullable(),
});

/** Confirm → fixed class workout + planned analysis → inline recompute → Today ("Parfait…"). */
export async function confirmInboxAction(
  itemId: string,
  date: string,
  start: string | null,
): Promise<void> {
  const user = await requireUser();
  const input = ConfirmInput.parse({ itemId, date, start });
  const db = await getDb();
  await confirmInboxItem(db, user.id, {
    itemId: input.itemId,
    date: input.date,
    startMinute: input.start ? clockToMinutes(input.start) : null,
    timezone: user.timezone,
  });
  const today = localDate(new Date(), user.timezone);
  await recompute(db, user.id, { timezone: user.timezone, date: today });
  revalidatePath("/today");
  revalidatePath("/calendar");
  revalidatePath("/inbox");
  redirect(input.date === today ? "/today" : "/calendar");
}

export async function discardInboxAction(itemId: string): Promise<void> {
  const user = await requireUser();
  const db = await getDb();
  await discardInboxItem(db, user.id, z.string().uuid().parse(itemId));
  revalidatePath("/inbox");
  redirect("/inbox");
}
