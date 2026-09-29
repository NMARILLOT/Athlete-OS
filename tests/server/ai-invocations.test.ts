import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { seedCatalog } from "@/db/seed";
import { createTestDb, type TestDb } from "@/db/test-db";
import type * as AiModule from "@/server/providers/ai";
import type { AiProvider } from "@/server/providers/ai/types";
import {
  AiCapExceededError,
  parseIntentGuarded,
  parseWodGuarded,
  recordInvocation,
} from "@/server/services/ai-invocations.service";
import { createInboxItem, parseInboxItem } from "@/server/services/inbox.service";

vi.mock("server-only", () => ({}));

/**
 * Layer B budget on a *degraded* provider (ADR-022): `AnthropicAiProvider` never throws — on
 * timeout, refusal or schema rejection it answers with the heuristic fallback under the mock's
 * meta. The provider below is named like the real one and behaves the same while `state.degraded`.
 */
const state = vi.hoisted(() => ({ degraded: true }));
const MODEL = "test-model";

vi.mock("@/server/providers/ai", async (importOriginal) => {
  const mod = await importOriginal<typeof AiModule>();
  const { MockAiProvider } = await import("@/server/providers/ai/mock");
  const fallback = new MockAiProvider();
  const fake: AiProvider = {
    name: "anthropic",
    parseWodKey: (input) => ({
      kind: "parse_wod",
      model: MODEL,
      promptVersion: "parse_wod_v1",
      inputHash: mod.hashInput({ text: input.text, v: "parse_wod_v1" }),
    }),
    parseIntentKey: (input) => ({
      kind: "parse_intent",
      model: MODEL,
      promptVersion: "parse_intent_v1",
      inputHash: mod.hashInput({ text: input.text, today: input.today, v: "parse_intent_v1" }),
    }),
    async parseWod(input) {
      const res = await fallback.parseWod({ text: input.text });
      if (state.degraded) return res;
      return {
        output: { ...res.output, parser: "AI_PARSED", parserVersion: "parse_wod_v1" },
        meta: {
          ...this.parseWodKey(input),
          latencyMs: 12,
          tokensIn: 100,
          tokensOut: 40,
          provider: "anthropic",
        },
      };
    },
    async parseIntent(input) {
      const res = await fallback.parseIntent(input);
      if (state.degraded) return res;
      return {
        output: res.output,
        meta: {
          ...this.parseIntentKey(input),
          latencyMs: 8,
          tokensIn: 50,
          tokensOut: 10,
          provider: "anthropic",
        },
      };
    },
    explain: (input) => fallback.explain(input),
  };
  return { ...mod, aiProvider: () => fake };
});

const USER_A = "00000000-0000-4000-8000-0000000000a1";
const USER_B = "00000000-0000-4000-8000-0000000000a2";
const USER_C = "00000000-0000-4000-8000-0000000000a3";
const FRAN = "Fran\n21-15-9\nThrusters 43/30 kg\nPull-ups";

let handle: TestDb;

beforeAll(async () => {
  handle = await createTestDb();
  await handle.db.insert(schema.users).values([
    { id: USER_A, email: "ai-a@example.test" },
    { id: USER_B, email: "ai-b@example.test" },
    { id: USER_C, email: "ai-c@example.test" },
  ]);
  await seedCatalog(handle.db);
});

afterAll(async () => {
  await handle.close();
});

afterEach(() => {
  delete process.env.AI_DAILY_CAP_PARSE_WOD;
  delete process.env.AI_DAILY_CAP_PARSE_INTENT;
  state.degraded = true;
});

async function invocations(userId: string, kind: string) {
  return handle.db
    .select()
    .from(schema.aiInvocations)
    .where(and(eq(schema.aiInvocations.userId, userId), eq(schema.aiInvocations.kind, kind)))
    .orderBy(schema.aiInvocations.createdAt);
}

describe("AI budget on a degraded provider (ADR-022)", () => {
  it("audits a provider fallback as a failed attempt under the provider's key and still answers heuristically", async () => {
    const res = await parseWodGuarded(handle.db, USER_A, { text: FRAN });
    expect(res.reused).toBe(false);
    expect(res.meta.provider).toBe("mock");
    expect(res.output.parser).toBe("HEURISTIC");
    const rows = await invocations(USER_A, "parse_wod");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      model: MODEL,
      promptVersion: "parse_wod_v1",
      valid: false,
      output: null,
      tokensIn: 0,
      tokensOut: 0,
    });
    expect(rows[0]?.error).toMatch(/fallback/);
  });

  it("counts every retry of the same text (failed attempts never dedupe) until the cap stops the model", async () => {
    process.env.AI_DAILY_CAP_PARSE_WOD = "3";
    await parseWodGuarded(handle.db, USER_A, { text: FRAN });
    await parseWodGuarded(handle.db, USER_A, { text: FRAN });
    expect(await invocations(USER_A, "parse_wod")).toHaveLength(3);
    await expect(parseWodGuarded(handle.db, USER_A, { text: FRAN })).rejects.toBeInstanceOf(
      AiCapExceededError,
    );
    expect(await invocations(USER_A, "parse_wod")).toHaveLength(3);
  });

  it("stores the model's own valid output once it answers, reuses it, and keeps one valid row per key", async () => {
    state.degraded = false;
    const first = await parseWodGuarded(handle.db, USER_B, { text: FRAN });
    expect(first.reused).toBe(false);
    expect(first.meta.provider).toBe("anthropic");
    expect(first.output.parser).toBe("AI_PARSED");
    const second = await parseWodGuarded(handle.db, USER_B, { text: FRAN });
    expect(second.reused).toBe(true);
    expect(second.output).toEqual(first.output);
    const rows = await invocations(USER_B, "parse_wod");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ valid: true, tokensIn: 100, tokensOut: 40 });
    // The cache index only covers valid rows: a duplicate valid row is ignored, failed attempts insert freely.
    await recordInvocation(handle.db, USER_B, first.meta, first.output, true, null);
    expect(await invocations(USER_B, "parse_wod")).toHaveLength(1);
    await recordInvocation(handle.db, USER_B, first.meta, null, false, "timeout");
    await recordInvocation(handle.db, USER_B, first.meta, null, false, "refusal");
    expect(await invocations(USER_B, "parse_wod")).toHaveLength(3);
    // The stored valid output is still the one reused.
    expect((await parseWodGuarded(handle.db, USER_B, { text: FRAN })).reused).toBe(true);
  });

  it("audits an intent fallback the same way and reuses the model's answer once it comes", async () => {
    const input = { text: "J'ai envie de courir", today: "2026-09-28", tomorrow: "2026-09-29" };
    const degraded = await parseIntentGuarded(handle.db, USER_B, input);
    expect(degraded.output.kind).toBe("want_run");
    expect(degraded.meta.provider).toBe("mock");
    expect(await invocations(USER_B, "parse_intent")).toMatchObject([
      { model: MODEL, promptVersion: "parse_intent_v1", valid: false },
    ]);
    state.degraded = false;
    const answered = await parseIntentGuarded(handle.db, USER_B, input);
    expect(answered.reused).toBe(false);
    expect(answered.meta.provider).toBe("anthropic");
    expect((await parseIntentGuarded(handle.db, USER_B, input)).reused).toBe(true);
    expect(await invocations(USER_B, "parse_intent")).toHaveLength(2);
  });

  it("tells the athlete when the cap skipped the model (warning on the WOD, no error)", async () => {
    process.env.AI_DAILY_CAP_PARSE_WOD = "1";
    const item = await createInboxItem(handle.db, USER_C, { text: "For time\n50 burpees" });
    // The first (degraded) attempt is recorded and reaches the cap.
    const first = await parseInboxItem(handle.db, USER_C, item.id);
    expect(first.parseSource).toBe("HEURISTIC");
    expect(await invocations(USER_C, "parse_wod")).toHaveLength(1);
    // "Ré-analyser": capped → heuristic structure, and the athlete is told why.
    const again = await parseInboxItem(handle.db, USER_C, item.id, { force: true });
    expect(again.parseSource).toBe("HEURISTIC");
    expect(again.normalizedWod?.warnings.join(" ")).toContain(
      "Limite quotidienne d'analyses IA atteinte (1/jour)",
    );
    expect(again.lastError).toBeNull();
    expect(again.normalizedWod?.parts.length).toBeGreaterThan(0);
    expect(await invocations(USER_C, "parse_wod")).toHaveLength(1);
  });
});
