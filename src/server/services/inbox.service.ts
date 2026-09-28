import "server-only";
import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { aiInvocations, wodInboxItems } from "@/db/schema";
import type { IsoDate } from "@/domain/core/dates";
import {
  analyzeWod,
  NormalizedWodSchema,
  parseWodText,
  WOD_ANALYZER_VERSION,
  type NormalizedWod,
} from "@/domain/wod";
import { NotFoundError, ValidationError } from "@/server/errors";
import { log } from "@/server/logging";
import { aiProvider, type AiInvocationMeta } from "@/server/providers/ai";
import { bestE1rmsByExercise } from "./strength-session.service";
import { createCrossfitWorkoutFromWod } from "./workout.service";
import type { InboxItemView } from "./view-models";

function toView(r: typeof wodInboxItems.$inferSelect): InboxItemView {
  return {
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    status: r.status,
    rawText: r.rawText,
    parseSource: r.parseSource,
    parseConfidence: r.parseConfidence,
    normalizedWod: r.normalizedWod,
    analysis: r.analysis,
    scheduledFor: r.scheduledFor,
    startLocal: r.startLocal,
    workoutId: r.workoutId,
    lastError: r.lastError,
  };
}

/** Save the raw paste FIRST (never lose the text), dedupe open items by content hash. */
export async function createInboxItem(
  db: Db,
  userId: string,
  opts: {
    text: string;
    inputKind?: "paste" | "quick" | "photo";
    scheduledFor?: IsoDate | null;
    startLocal?: string | null;
  },
): Promise<InboxItemView> {
  const text = opts.text.trim();
  if (!text) throw new ValidationError("Le WOD est vide.");
  const contentHash = createHash("sha256")
    .update(text.toLowerCase().replace(/\s+/g, " "))
    .digest("hex");
  const [existing] = await db
    .select()
    .from(wodInboxItems)
    .where(
      and(
        eq(wodInboxItems.userId, userId),
        eq(wodInboxItems.contentHash, contentHash),
        inArray(wodInboxItems.status, ["new", "parsed", "needs_review"]),
      ),
    )
    .limit(1);
  if (existing) return toView(existing);
  const [row] = await db
    .insert(wodInboxItems)
    .values({
      userId,
      inputKind: opts.inputKind ?? "paste",
      rawText: text,
      contentHash,
      status: "new",
      scheduledFor: opts.scheduledFor ?? null,
      startLocal: opts.startLocal ?? null,
    })
    .returning();
  if (!row) throw new Error("inbox insert failed");
  return toView(row);
}

async function recordInvocation(
  db: Db,
  userId: string,
  meta: AiInvocationMeta,
  output: unknown,
  valid: boolean,
  error: string | null,
): Promise<void> {
  await db
    .insert(aiInvocations)
    .values({
      userId,
      kind: meta.kind,
      model: meta.model,
      promptVersion: meta.promptVersion,
      inputHash: meta.inputHash,
      output,
      valid,
      error,
      latencyMs: meta.latencyMs,
      tokensIn: meta.tokensIn,
      tokensOut: meta.tokensOut,
    })
    .onConflictDoNothing();
}

/** Parse (AI or heuristic) + deterministic analysis. Status: parsed (≥ 0.7) or needs_review. */
export async function parseInboxItem(
  db: Db,
  userId: string,
  itemId: string,
  opts: { force?: boolean } = {},
): Promise<InboxItemView> {
  const [item] = await db
    .select()
    .from(wodInboxItems)
    .where(and(eq(wodInboxItems.id, itemId), eq(wodInboxItems.userId, userId)))
    .limit(1);
  if (!item) throw new NotFoundError("Élément de l'inbox");
  if (!item.rawText) throw new ValidationError("Aucun texte à analyser.");
  if (item.normalizedWod && item.status !== "new" && !opts.force) return toView(item);
  let wod: NormalizedWod;
  let source = "HEURISTIC";
  let confidence = 0;
  try {
    const res = await aiProvider().parseWod({ text: item.rawText });
    wod = res.output;
    source =
      res.meta.provider === "anthropic" && wod.parser === "AI_PARSED" ? "AI_PARSED" : "HEURISTIC";
    await recordInvocation(db, userId, res.meta, wod, true, null);
    confidence = wod.parseConfidence;
  } catch (err) {
    log.warn("inbox.parse.failed", {
      userId,
      inboxItemId: itemId,
      errorName: err instanceof Error ? err.name : "unknown",
    });
    wod = parseWodText(item.rawText);
    confidence = wod.parseConfidence;
  }
  const e1rms = await bestE1rmsByExercise(db, userId);
  const analysis = analyzeWod(wod, { e1rms });
  const status =
    confidence >= 0.7 && analysis.unknownMovements.length === 0 ? "parsed" : "needs_review";
  const [updated] = await db
    .update(wodInboxItems)
    .set({
      normalizedWod: wod,
      parseSource: source,
      parseConfidence: confidence,
      analysis,
      analysisVersion: WOD_ANALYZER_VERSION,
      status,
      lastError: null,
    })
    .where(eq(wodInboxItems.id, item.id))
    .returning();
  return toView(updated as typeof wodInboxItems.$inferSelect);
}

/** User corrected the text → re-parse. */
export async function updateInboxText(
  db: Db,
  userId: string,
  itemId: string,
  text: string,
): Promise<InboxItemView> {
  const contentHash = createHash("sha256")
    .update(text.trim().toLowerCase().replace(/\s+/g, " "))
    .digest("hex");
  await db
    .update(wodInboxItems)
    .set({ rawText: text.trim(), contentHash, status: "new", normalizedWod: null, analysis: null })
    .where(and(eq(wodInboxItems.id, itemId), eq(wodInboxItems.userId, userId)));
  return parseInboxItem(db, userId, itemId, { force: true });
}

/** Confirm: create the fixed class workout + planned analysis; the caller runs recompute. */
export async function confirmInboxItem(
  db: Db,
  userId: string,
  opts: { itemId: string; date: IsoDate; startMinute: number | null; timezone: string },
): Promise<{ workoutId: string }> {
  const [item] = await db
    .select()
    .from(wodInboxItems)
    .where(and(eq(wodInboxItems.id, opts.itemId), eq(wodInboxItems.userId, userId)))
    .limit(1);
  if (!item) throw new NotFoundError("Élément de l'inbox");
  if (item.workoutId) return { workoutId: item.workoutId };
  const wod = NormalizedWodSchema.parse(item.normalizedWod);
  const analysis =
    item.analysis ?? analyzeWod(wod, { e1rms: await bestE1rmsByExercise(db, userId) });
  const created = await createCrossfitWorkoutFromWod(db, userId, {
    date: opts.date,
    startMinute: opts.startMinute,
    timezone: opts.timezone,
    wod,
    analysis,
    inboxItemId: item.id,
  });
  await db
    .update(wodInboxItems)
    .set({
      status: "confirmed",
      workoutId: created.id,
      scheduledFor: opts.date,
      startLocal:
        opts.startMinute != null
          ? `${String(Math.floor(opts.startMinute / 60)).padStart(2, "0")}:${String(opts.startMinute % 60).padStart(2, "0")}`
          : null,
    })
    .where(eq(wodInboxItems.id, item.id));
  return { workoutId: created.id };
}

export async function discardInboxItem(db: Db, userId: string, itemId: string): Promise<void> {
  await db
    .update(wodInboxItems)
    .set({ status: "discarded" })
    .where(and(eq(wodInboxItems.id, itemId), eq(wodInboxItems.userId, userId)));
}

export async function getInboxItem(
  db: Db,
  userId: string,
  itemId: string,
): Promise<InboxItemView | null> {
  const [item] = await db
    .select()
    .from(wodInboxItems)
    .where(and(eq(wodInboxItems.id, itemId), eq(wodInboxItems.userId, userId)))
    .limit(1);
  return item ? toView(item) : null;
}

export async function listInbox(db: Db, userId: string, limit = 30): Promise<InboxItemView[]> {
  const rows = await db
    .select()
    .from(wodInboxItems)
    .where(eq(wodInboxItems.userId, userId))
    .orderBy(desc(wodInboxItems.createdAt))
    .limit(limit);
  return rows.map(toView);
}
