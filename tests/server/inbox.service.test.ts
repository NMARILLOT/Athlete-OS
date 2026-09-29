import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { seedCatalog } from "@/db/seed";
import { createTestDb, type TestDb } from "@/db/test-db";
import { MockAiProvider } from "@/server/providers/ai/mock";
import {
  AiCapExceededError,
  aiDailyCap,
  parseIntentGuarded,
} from "@/server/services/ai-invocations.service";
import {
  createInboxItem,
  discardInboxItem,
  parseInboxItem,
  updateInboxText,
} from "@/server/services/inbox.service";

vi.mock("server-only", () => ({}));

const USER_A = "00000000-0000-4000-8000-0000000000d1";
const USER_B = "00000000-0000-4000-8000-0000000000d2";
const FRAN = "Fran\n21-15-9\nThrusters 43/30 kg\nPull-ups";

let handle: TestDb;

beforeAll(async () => {
  handle = await createTestDb();
  await handle.db.insert(schema.users).values([
    { id: USER_A, email: "inbox-a@example.test" },
    { id: USER_B, email: "inbox-b@example.test" },
  ]);
  await seedCatalog(handle.db);
});

afterAll(async () => {
  await handle.close();
});

afterEach(() => {
  delete process.env.AI_DAILY_CAP_PARSE_WOD;
  delete process.env.AI_DAILY_CAP_PARSE_INTENT;
  vi.restoreAllMocks();
});

async function invocations(userId: string, kind: string) {
  return handle.db
    .select()
    .from(schema.aiInvocations)
    .where(and(eq(schema.aiInvocations.userId, userId), eq(schema.aiInvocations.kind, kind)));
}

describe("createInboxItem", () => {
  it("re-schedules an open duplicate paste instead of keeping the old date", async () => {
    const first = await createInboxItem(handle.db, USER_A, {
      text: FRAN,
      scheduledFor: "2026-09-29",
      startLocal: "18:30",
    });
    const again = await createInboxItem(handle.db, USER_A, {
      text: `  ${FRAN.toUpperCase()}  `,
      scheduledFor: "2026-10-01",
      startLocal: "12:15",
    });
    expect(again.id).toBe(first.id);
    expect(again.scheduledFor).toBe("2026-10-01");
    expect(again.startLocal?.startsWith("12:15")).toBe(true);
    // A bare re-paste keeps what was there.
    const bare = await createInboxItem(handle.db, USER_A, { text: FRAN });
    expect(bare.scheduledFor).toBe("2026-10-01");
    // Another user gets their own row.
    const other = await createInboxItem(handle.db, USER_B, { text: FRAN });
    expect(other.id).not.toBe(first.id);
  });
});

describe("AI invocation budget (ADR-022)", () => {
  it("reuses the stored valid output for identical inputs and audits each real call", async () => {
    const spy = vi.spyOn(MockAiProvider.prototype, "parseWod");
    const item = await createInboxItem(handle.db, USER_A, {
      text: "AMRAP 10\n5 pull-ups\n10 push-ups",
    });
    await parseInboxItem(handle.db, USER_A, item.id);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await invocations(USER_A, "parse_wod")).toHaveLength(1);
    // "Ré-analyser" with the same text → stored output, no provider call.
    const reparsed = await updateInboxText(
      handle.db,
      USER_A,
      item.id,
      "AMRAP 10\n5 pull-ups\n10 push-ups",
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(reparsed.normalizedWod?.parts.length).toBeGreaterThan(0);
    // A different text is a new call.
    await updateInboxText(
      handle.db,
      USER_A,
      item.id,
      "AMRAP 12\n5 pull-ups\n10 push-ups\n15 squats",
    );
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await invocations(USER_A, "parse_wod")).toHaveLength(2);
    await discardInboxItem(handle.db, USER_A, item.id);
  });

  it("stops calling the provider over the daily cap and still parses heuristically", async () => {
    process.env.AI_DAILY_CAP_PARSE_WOD = "2";
    expect(aiDailyCap("parse_wod")).toBe(2);
    const spy = vi.spyOn(MockAiProvider.prototype, "parseWod");
    const before = (await invocations(USER_A, "parse_wod")).length;
    const item = await createInboxItem(handle.db, USER_A, { text: "For time\n50 burpees" });
    const parsed = await parseInboxItem(handle.db, USER_A, item.id);
    expect(spy).not.toHaveBeenCalled();
    expect(["parsed", "needs_review"]).toContain(parsed.status);
    expect(parsed.parseSource).toBe("HEURISTIC");
    expect((await invocations(USER_A, "parse_wod")).length).toBe(before);
    // The cap is per user.
    const other = await createInboxItem(handle.db, USER_B, { text: "For time\n50 burpees" });
    await parseInboxItem(handle.db, USER_B, other.id);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("records, reuses and caps intent parsing", async () => {
    const input = { text: "J'ai envie de courir", today: "2026-09-28", tomorrow: "2026-09-29" };
    const first = await parseIntentGuarded(handle.db, USER_A, input);
    expect(first.reused).toBe(false);
    expect(first.output.kind).toBe("want_run");
    const second = await parseIntentGuarded(handle.db, USER_A, input);
    expect(second.reused).toBe(true);
    expect(second.output).toEqual(first.output);
    expect(await invocations(USER_A, "parse_intent")).toHaveLength(1);
    // The next day is a new call: the parsed date is relative to today.
    const nextDay = await parseIntentGuarded(handle.db, USER_A, {
      ...input,
      today: "2026-09-29",
      tomorrow: "2026-09-30",
    });
    expect(nextDay.reused).toBe(false);
    expect(nextDay.output.date).toBe("2026-09-29");
    process.env.AI_DAILY_CAP_PARSE_INTENT = "2";
    await expect(
      parseIntentGuarded(handle.db, USER_A, { ...input, text: "Repos aujourd'hui" }),
    ).rejects.toBeInstanceOf(AiCapExceededError);
  });
});
