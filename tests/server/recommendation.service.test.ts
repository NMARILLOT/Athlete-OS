import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { seedCatalog } from "@/db/seed";
import { createTestDb, type TestDb } from "@/db/test-db";
import { assembleEngineInput } from "@/server/services/engine-input";
import { declareIntent, declareReadiness } from "@/server/services/readiness.service";
import {
  applyReschedules,
  getRecommendation,
  pendingReschedules,
  recompute,
  resolveRecommendation,
} from "@/server/services/recommendation.service";
import { createWorkoutFromOption, optionFromCatalog } from "@/server/services/workout.service";

vi.mock("server-only", () => ({}));

const USER_A = "00000000-0000-4000-8000-0000000000a9";
const USER_B = "00000000-0000-4000-8000-0000000000b9";
const TZ = "Europe/Paris";
const TODAY = "2026-09-28";
const NOW = new Date("2026-09-28T07:30:00.000Z");

let handle: TestDb;

beforeAll(async () => {
  handle = await createTestDb();
  await handle.db.insert(schema.users).values([
    { id: USER_A, email: "reco-a@example.test" },
    { id: USER_B, email: "reco-b@example.test" },
  ]);
  await seedCatalog(handle.db);
});

afterAll(async () => {
  await handle.close();
});

describe("engine reschedules (spec §32 / §53)", () => {
  it("exposes the planned session the engine outscored and applies the move on demand", async () => {
    const option = optionFromCatalog("strength_lower");
    if (!option) throw new Error("catalog");
    const planned = await createWorkoutFromOption(handle.db, USER_A, {
      option,
      date: TODAY,
      timezone: TZ,
      recommendationId: null,
      startMinute: 18 * 60,
    });
    await declareReadiness(handle.db, USER_A, {
      date: TODAY,
      energy: 3,
      soreness: 0,
      motivation: 3,
      unusualPain: false,
    });
    await declareIntent(handle.db, USER_A, { date: TODAY, kind: "want_run" });
    const rec = await recompute(handle.db, USER_A, { now: NOW, timezone: TZ });
    expect(rec.output.primary.family.startsWith("run")).toBe(true);
    const suggested = rec.output.reschedules.find((r) => r.plannedId === planned.id);
    expect(suggested).toBeDefined();
    expect(suggested?.toDate).not.toBeNull();

    const pending = await pendingReschedules(handle.db, USER_A, rec.output);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      plannedId: planned.id,
      title: option.title,
      fromDate: TODAY,
      toDate: suggested?.toDate,
    });
    // Another user sees nothing to apply from this recommendation.
    expect(await pendingReschedules(handle.db, USER_B, rec.output)).toEqual([]);

    const { applied } = await applyReschedules(handle.db, USER_A, { timezone: TZ, today: TODAY });
    expect(applied.map((a) => a.plannedId)).toEqual([planned.id]);
    const [moved] = await handle.db
      .select()
      .from(schema.workouts)
      .where(eq(schema.workouts.id, planned.id));
    expect(moved?.date).toBe(suggested?.toDate);
    expect(moved?.status).toBe("auto_adjusted");
    // Applied once: the old output no longer yields anything pending, and the moved session stays planned for the engine.
    expect(await pendingReschedules(handle.db, USER_A, rec.output)).toEqual([]);
    const input = await assembleEngineInput(handle.db, USER_A, { now: NOW, timezone: TZ });
    expect(input.planned.find((p) => p.id === planned.id)).toMatchObject({
      date: suggested?.toDate,
      status: "planned",
    });
    const next = await recompute(handle.db, USER_A, { now: NOW, timezone: TZ });
    expect(next.output.reschedules.find((r) => r.plannedId === planned.id)).toBeUndefined();
    expect(
      (await applyReschedules(handle.db, USER_A, { timezone: TZ, today: TODAY })).applied,
    ).toEqual([]);
  });

  it("never lists nor moves a session already started, as the calendar's checkMove forbids it", async () => {
    const option = optionFromCatalog("strength_lower");
    if (!option) throw new Error("catalog");
    const started = await createWorkoutFromOption(handle.db, USER_B, {
      option,
      date: TODAY,
      timezone: TZ,
      recommendationId: null,
      startMinute: 18 * 60,
    });
    await handle.db
      .update(schema.workouts)
      .set({ status: "in_progress" })
      .where(eq(schema.workouts.id, started.id));
    await declareReadiness(handle.db, USER_B, {
      date: TODAY,
      energy: 3,
      soreness: 0,
      motivation: 3,
      unusualPain: false,
    });
    await declareIntent(handle.db, USER_B, { date: TODAY, kind: "want_run" });
    const rec = await recompute(handle.db, USER_B, { now: NOW, timezone: TZ });
    expect(rec.output.primary.family.startsWith("run")).toBe(true);
    // Whether or not the engine proposes the move, nothing is pending nor applied for it.
    const proposed = {
      ...rec.output,
      reschedules: [
        { plannedId: started.id, fromDate: TODAY, toDate: "2026-09-30", reason: "test" },
      ],
    };
    expect(await pendingReschedules(handle.db, USER_B, proposed)).toEqual([]);
    expect(
      (await applyReschedules(handle.db, USER_B, { timezone: TZ, today: TODAY })).applied,
    ).toEqual([]);
    const [row] = await handle.db
      .select()
      .from(schema.workouts)
      .where(eq(schema.workouts.id, started.id));
    expect(row).toMatchObject({ date: TODAY, status: "in_progress" });
    expect(row?.startAt?.toISOString()).toBe("2026-09-28T16:00:00.000Z");
  });

  it("reads a stored recommendation by id only for its owner", async () => {
    const rec = await recompute(handle.db, USER_A, { now: NOW, timezone: TZ });
    expect((await getRecommendation(handle.db, USER_A, rec.id))?.id).toBe(rec.id);
    expect(await getRecommendation(handle.db, USER_B, rec.id)).toBeNull();
  });

  it("resolves a START to today's recommendation, never to a stale (previous-day) id", async () => {
    const yesterday = await recompute(handle.db, USER_A, {
      now: new Date("2026-09-27T07:30:00.000Z"),
      timezone: TZ,
    });
    expect(yesterday.date).toBe("2026-09-27");
    const today = await recompute(handle.db, USER_A, { now: NOW, timezone: TZ });
    const resolve = (userId: string, recommendationId: string | null) =>
      resolveRecommendation(handle.db, userId, { recommendationId, date: TODAY });
    expect((await resolve(USER_A, today.id))?.id).toBe(today.id);
    // A Today tab left open overnight sends yesterday's id: today's current row answers instead.
    expect((await resolve(USER_A, yesterday.id))?.id).toBe(today.id);
    expect((await resolve(USER_A, null))?.id).toBe(today.id);
    // Another user's id is not theirs to use.
    expect((await resolve(USER_B, today.id))?.id).not.toBe(today.id);
  });
});
