import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { seedCatalog } from "@/db/seed";
import { createTestDb, type TestDb } from "@/db/test-db";
import type { CurrentUser } from "@/server/auth/types";
import { runDailyJobs } from "@/server/jobs/daily";
import { confirmInboxItem, createInboxItem, parseInboxItem } from "@/server/services/inbox.service";
import { declareIntent, declareReadiness, logPain } from "@/server/services/readiness.service";
import { getCurrentRecommendation, recompute } from "@/server/services/recommendation.service";
import { createStrengthWorkoutFromTemplate } from "@/server/services/strength-session.service";
import { getTodayView } from "@/server/services/today.service";
import {
  completeWorkout,
  createWorkoutFromOption,
  findOpenWorkoutForOption,
} from "@/server/services/workout.service";

vi.mock("server-only", () => ({}));

/**
 * End-to-end pipeline on PGlite: Today → recommendation → START → feedback → ledger → next
 * recommendation, plus the WOD inbox and readiness/intent/pain inputs (ARCHITECTURE §4).
 */
const USER: CurrentUser = {
  id: "00000000-0000-4000-8000-0000000000c1",
  email: "c@example.test",
  timezone: "Europe/Paris",
  displayName: "C",
  onboardingCompletedAt: null,
};
const NOW = new Date("2026-09-28T07:30:00.000Z"); // Monday 09:30 Paris
const TODAY = "2026-09-28";

let handle: TestDb;

beforeAll(async () => {
  handle = await createTestDb();
  await handle.db.insert(schema.users).values({ id: USER.id, email: USER.email });
  await seedCatalog(handle.db);
});

afterAll(async () => {
  await handle.close();
});

describe("today pipeline", () => {
  it("computes a first recommendation for a fresh user (baseline phase, LOW/MEDIUM confidence)", async () => {
    const view = await getTodayView(handle.db, USER, NOW);
    expect(view.date).toBe(TODAY);
    expect(view.recommendation).not.toBeNull();
    expect(view.recommendationId).not.toBeNull();
    expect(view.baselinePhase).toBe(true);
    expect(view.onboardingDone).toBe(false);
    const rec = view.recommendation;
    expect(rec?.primary.title).toBeTruthy();
    expect(rec?.explanation.length).toBeGreaterThan(10);
    expect(["LOW", "MEDIUM", "HIGH"]).toContain(rec?.confidence.level);
    expect(rec?.weekOutlook).toHaveLength(7);
    // Reading again returns the same stored version (no recompute on read).
    const again = await getTodayView(handle.db, USER, NOW);
    expect(again.recommendationId).toBe(view.recommendationId);
  });

  it("versions recommendations on recompute and keeps exactly one current row per day", async () => {
    const before = await getCurrentRecommendation(handle.db, USER.id, TODAY);
    await declareReadiness(handle.db, USER.id, {
      date: TODAY,
      energy: 1,
      soreness: 3,
      motivation: 1,
      unusualPain: false,
    });
    const after = await recompute(handle.db, USER.id, { now: NOW, timezone: USER.timezone });
    expect(after.version).toBe((before?.version ?? 0) + 1);
    const current = await handle.db
      .select()
      .from(schema.recommendations)
      .where(
        and(
          eq(schema.recommendations.userId, USER.id),
          eq(schema.recommendations.date, TODAY),
          eq(schema.recommendations.superseded, false),
        ),
      );
    expect(current).toHaveLength(1);
    expect(current[0]?.version).toBe(after.version);
    // Poor readiness never yields a hard primary session.
    expect(after.output.trace.derived.readinessBand).toBe("poor");
    expect(after.output.primary.intensity).not.toBe("hard");
  });

  it("START materialises the option, feedback writes the actual analysis and feeds the next recommendation", async () => {
    await declareReadiness(handle.db, USER.id, {
      date: TODAY,
      energy: 3,
      soreness: 0,
      motivation: 3,
      unusualPain: false,
    });
    await declareIntent(handle.db, USER.id, { date: TODAY, kind: "want_run" });
    const rec = await recompute(handle.db, USER.id, { now: NOW, timezone: USER.timezone });
    expect(rec.output.primary.family.startsWith("run")).toBe(true);
    const created = await createWorkoutFromOption(handle.db, USER.id, {
      option: rec.output.primary,
      date: TODAY,
      timezone: USER.timezone,
      recommendationId: rec.id,
      startMinute: 9 * 60 + 30,
    });
    expect(created.type).toBe("cardio");
    await completeWorkout(handle.db, USER.id, {
      workoutId: created.id,
      rpe: 4,
      feeling: "great",
      painReported: false,
      actualDurationMin: 45,
      finishedAt: new Date("2026-09-28T08:20:00.000Z"),
    });
    const analyses = await handle.db
      .select()
      .from(schema.workoutAnalyses)
      .where(eq(schema.workoutAnalyses.workoutId, created.id));
    expect(analyses.map((a) => a.phase).sort()).toEqual(["actual", "planned"]);
    const next = await recompute(handle.db, USER.id, {
      now: new Date("2026-09-28T10:00:00.000Z"),
      timezone: USER.timezone,
    });
    expect(next.output.primaryDone).toBe(true);
    const view = await getTodayView(handle.db, USER, new Date("2026-09-28T10:00:00.000Z"));
    expect(view.workouts.map((w) => w.status)).toContain("done");
    expect(view.workouts.find((w) => w.id === created.id)?.rpe).toBe(4);
  });

  it("START on a planned free session reuses it instead of inserting a duplicate", async () => {
    const { workoutId } = await createStrengthWorkoutFromTemplate(handle.db, USER.id, {
      templateId: "full_a",
      date: TODAY,
    });
    const rec = await recompute(handle.db, USER.id, {
      now: new Date("2026-09-28T10:30:00.000Z"),
      timezone: USER.timezone,
    });
    const [snapshot] = await handle.db
      .select({ input: schema.recommendations.inputsSnapshot })
      .from(schema.recommendations)
      .where(eq(schema.recommendations.id, rec.id));
    expect(snapshot?.input.planned.map((p) => p.id)).toContain(workoutId);
    const before = await handle.db
      .select({ id: schema.workouts.id })
      .from(schema.workouts)
      .where(and(eq(schema.workouts.userId, USER.id), eq(schema.workouts.date, TODAY)));
    // The action resolves the option to the open session (by plannedId, else by kind) and routes to it.
    const byId = await findOpenWorkoutForOption(handle.db, USER.id, {
      date: TODAY,
      kind: "strength_full",
      plannedId: workoutId,
    });
    const byKind = await findOpenWorkoutForOption(handle.db, USER.id, {
      date: TODAY,
      kind: "strength_full",
    });
    expect(byId?.id).toBe(workoutId);
    expect(byKind?.id).toBe(workoutId);
    const after = await handle.db
      .select({ id: schema.workouts.id })
      .from(schema.workouts)
      .where(and(eq(schema.workouts.userId, USER.id), eq(schema.workouts.date, TODAY)));
    expect(after).toHaveLength(before.length);
  });

  it("confirms a pasted WOD into a fixed class that the engine plans around", async () => {
    const item = await createInboxItem(handle.db, USER.id, {
      text: "Fran\n21-15-9\nThrusters 43/30 kg\nPull-ups",
      inputKind: "paste",
      scheduledFor: "2026-09-29",
      startLocal: "18:30",
    });
    const parsed = await parseInboxItem(handle.db, USER.id, item.id);
    expect(["parsed", "needs_review"]).toContain(parsed.status);
    expect(parsed.analysis?.intensity).toBe("hard");
    await confirmInboxItem(handle.db, USER.id, {
      itemId: item.id,
      date: "2026-09-29",
      startMinute: 18 * 60 + 30,
      timezone: USER.timezone,
    });
    const [w] = await handle.db
      .select()
      .from(schema.workouts)
      .where(and(eq(schema.workouts.userId, USER.id), eq(schema.workouts.type, "crossfit")));
    expect(w?.fixed).toBe(true);
    expect(w?.date).toBe("2026-09-29");
    const rec = await recompute(handle.db, USER.id, {
      now: new Date("2026-09-28T10:00:00.000Z"),
      timezone: USER.timezone,
    });
    const tomorrow = rec.output.weekOutlook?.find((d) => d.date === "2026-09-29");
    expect(tomorrow?.fixed.some((f) => f.id === w?.id)).toBe(true);
    expect(tomorrow?.primary.fixed).toBe(true);
  });

  it("active pain reaches the engine and the daily cron recomputes every user", async () => {
    const pain = await logPain(handle.db, USER.id, {
      location: "knee",
      side: "left",
      intensity: 6,
      movementSpecific: true,
      movements: ["box_jump", "running"],
      sudden: false,
      persistent: true,
    });
    expect(pain.medicalAdvice).toBe(false);
    const summary = await runDailyJobs(handle.db, new Date("2026-09-29T04:00:00.000Z"));
    expect(summary.users).toBe(1);
    expect(summary.recomputed).toBe(1);
    const rec = await getCurrentRecommendation(handle.db, USER.id, "2026-09-29");
    expect(rec).not.toBeNull();
    expect(rec?.output.trace.derived).toBeTruthy();
    const snapshot = rec?.output
      ? await handle.db
          .select()
          .from(schema.recommendations)
          .where(eq(schema.recommendations.id, rec.id))
      : [];
    expect(snapshot[0]?.inputsSnapshot.pain.map((p) => p.location)).toContain("knee");
  });
});
