import "server-only";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { aiInvocations } from "@/db/schema";
import { INTENSITY_BAND_VALUES, INTENT_KIND_VALUES, type UserIntent } from "@/domain/core";
import { NormalizedWodSchema, type NormalizedWod } from "@/domain/wod";
import { ValidationError } from "@/server/errors";
import { log } from "@/server/logging";
import {
  aiProvider,
  type AiCallKey,
  type AiInvocationMeta,
  type AiResult,
} from "@/server/providers/ai";

/**
 * Layer B budget (ADR-022, ARCHITECTURE §6): every provider call is recorded in `ai_invocations`;
 * identical inputs (same kind / prompt version / model / input hash) reuse the stored valid output
 * instead of spending again, and each kind has a per-user cap over a rolling 24 h window. A capped
 * call throws `AiCapExceededError`; callers degrade to the deterministic parsers (never a blocker).
 */

const DEFAULT_DAILY_CAPS: Record<AiInvocationMeta["kind"], number> = {
  parse_wod: 30,
  parse_intent: 50,
  explain: 100,
  suggest_fun: 20,
  monthly_review: 5,
};
const WINDOW_MS = 24 * 3600 * 1000;

/** Cap for a kind: `AI_DAILY_CAP_<KIND>` (positive integer) or the documented default. */
export function aiDailyCap(kind: AiInvocationMeta["kind"]): number {
  const raw = process.env[`AI_DAILY_CAP_${kind.toUpperCase()}`];
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_CAPS[kind];
}

export class AiCapExceededError extends ValidationError {
  constructor(
    public readonly kind: AiInvocationMeta["kind"],
    public readonly cap: number,
  ) {
    super(
      `Limite quotidienne d'analyses IA atteinte (${cap}/jour) : analyse heuristique utilisée.`,
    );
    this.name = "AiCapExceededError";
  }
}

export async function recordInvocation(
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

/** Stored valid output for this exact call, or null. Raw JSON: the caller re-validates it. */
export async function findValidOutput(db: Db, key: AiCallKey): Promise<unknown | null> {
  const [row] = await db
    .select({ output: aiInvocations.output })
    .from(aiInvocations)
    .where(
      and(
        eq(aiInvocations.kind, key.kind),
        eq(aiInvocations.promptVersion, key.promptVersion),
        eq(aiInvocations.model, key.model),
        eq(aiInvocations.inputHash, key.inputHash),
        eq(aiInvocations.valid, true),
      ),
    )
    .orderBy(desc(aiInvocations.createdAt))
    .limit(1);
  return row?.output ?? null;
}

export async function countInvocationsSince(
  db: Db,
  userId: string,
  kind: AiInvocationMeta["kind"],
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(aiInvocations)
    .where(
      and(
        eq(aiInvocations.userId, userId),
        eq(aiInvocations.kind, kind),
        gte(aiInvocations.createdAt, since),
      ),
    );
  return row?.n ?? 0;
}

/** Throws `AiCapExceededError` when the user already made `cap` calls of this kind in the last 24 h. */
export async function assertUnderDailyCap(
  db: Db,
  userId: string,
  kind: AiInvocationMeta["kind"],
  opts: { now?: Date; cap?: number } = {},
): Promise<void> {
  const cap = opts.cap ?? aiDailyCap(kind);
  const now = opts.now ?? new Date();
  const n = await countInvocationsSince(db, userId, kind, new Date(now.getTime() - WINDOW_MS));
  if (n >= cap) {
    log.warn("ai.cap_exceeded", { userId, kind, count: cap });
    throw new AiCapExceededError(kind, cap);
  }
}

function reusedMeta(key: AiCallKey): AiInvocationMeta {
  return {
    ...key,
    latencyMs: 0,
    tokensIn: 0,
    tokensOut: 0,
    provider: key.model === "heuristic" ? "mock" : "anthropic",
  };
}

/**
 * `parseWod` with reuse → cap → call → audit. Returns `reused: true` when no provider call was made.
 * A capped call throws (the inbox falls back to the heuristic parser).
 */
export async function parseWodGuarded(
  db: Db,
  userId: string,
  input: { text: string },
  opts: { now?: Date } = {},
): Promise<AiResult<NormalizedWod> & { reused: boolean }> {
  const provider = aiProvider();
  const key = provider.parseWodKey(input);
  const cached = NormalizedWodSchema.safeParse(await findValidOutput(db, key));
  if (cached.success) return { output: cached.data, meta: reusedMeta(key), reused: true };
  await assertUnderDailyCap(db, userId, "parse_wod", { now: opts.now });
  const res = await provider.parseWod(input);
  await recordInvocation(db, userId, res.meta, res.output, true, null);
  return { ...res, reused: false };
}

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const StoredIntentSchema = z.object({
  kind: z.enum(INTENT_KIND_VALUES),
  intensity: z.enum(INTENSITY_BAND_VALUES).optional(),
  availableMinutes: z.number().int().min(10).max(300).optional(),
  rawText: z.string().max(200).optional(),
  date: IsoDate.optional(),
});

/** `parseIntent` with reuse → cap → call → audit (the intent parser was never recorded before). */
export async function parseIntentGuarded(
  db: Db,
  userId: string,
  input: { text: string; today: string; tomorrow: string },
  opts: { now?: Date } = {},
): Promise<AiResult<UserIntent> & { reused: boolean }> {
  const provider = aiProvider();
  const key = provider.parseIntentKey(input);
  const cached = StoredIntentSchema.safeParse(await findValidOutput(db, key));
  if (cached.success) return { output: cached.data, meta: reusedMeta(key), reused: true };
  await assertUnderDailyCap(db, userId, "parse_intent", { now: opts.now });
  const res = await provider.parseIntent(input);
  await recordInvocation(db, userId, res.meta, res.output, true, null);
  return { ...res, reused: false };
}
