import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { seedCatalog } from "@/db/seed";
import { createTestDb, type TestDb } from "@/db/test-db";
import { closeStaleInProgress, runDailyJobs } from "@/server/jobs/daily";
import {
  applyStrengthEvents,
  createStrengthWorkoutFromTemplate,
  type OutboxEventInput,
} from "@/server/services/strength-session.service";

vi.mock("server-only", () => ({}));

/**
 * Daily stale-session sweep (ARCHITECTURE §4.7): keyed on activity (start / last logged set older
 * than a day), never on the plan date alone; closes with what was logged and no invented RPE;
 * sends a never-performed session back to `planned`; and still accepts the athlete's own late
 * finish afterwards (offline gym, app opened days later).
 */
const USER = "00000000-0000-4000-8000-0000000000e1";
const NOW = new Date("2026-09-28T04:00:00.000Z"); // the cron: 06:00 Paris
const TODAY = "2026-09-28";
const OLD_DATE = "2026-09-25"; // three days ago
const uuid = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let handle: TestDb;
let seq = 0;
const nextId = () => uuid(++seq);

beforeAll(async () => {
  handle = await createTestDb();
  await handle.db
    .insert(schema.users)
    .values({ id: USER, email: "e@example.test", timezone: "Europe/Paris" });
  await seedCatalog(handle.db);
});

afterAll(async () => {
  await handle.close();
});

async function workoutRow(id: string) {
  const [w] = await handle.db.select().from(schema.workouts).where(eq(schema.workouts.id, id));
  if (!w) throw new Error("no workout");
  return w;
}

async function actualAnalysis(workoutId: string) {
  const [a] = await handle.db
    .select()
    .from(schema.workoutAnalyses)
    .where(
      and(
        eq(schema.workoutAnalyses.workoutId, workoutId),
        eq(schema.workoutAnalyses.phase, "actual"),
      ),
    );
  return a ?? null;
}

/** A lower_a workout dated `date`, started at `startedAt` through the outbox, with optional sets. */
async function startedWorkout(opts: {
  date: string;
  startedAt: string;
  sets?: Array<{ at: string; reps: number; weightKg: number }>;
}): Promise<{ workoutId: string; wxId: string }> {
  const db = handle.db;
  const { workoutId } = await createStrengthWorkoutFromTemplate(db, USER, {
    templateId: "lower_a",
    date: opts.date,
  });
  const [wx] = await db
    .select()
    .from(schema.workoutExercises)
    .where(eq(schema.workoutExercises.workoutId, workoutId))
    .orderBy(schema.workoutExercises.order)
    .limit(1);
  if (!wx) throw new Error("no exercise");
  const events: OutboxEventInput[] = [
    {
      id: nextId(),
      workoutId,
      seq: 0,
      type: "session_started",
      payload: { date: opts.date, startedAt: opts.startedAt },
      at: opts.startedAt,
    },
    ...(opts.sets ?? []).map((s, i): OutboxEventInput => ({
      id: nextId(),
      workoutId,
      seq: i + 1,
      type: "set_completed",
      payload: {
        set: {
          id: nextId(),
          workoutExerciseId: wx.id,
          setIndex: i + 1,
          reps: s.reps,
          weightKg: s.weightKg,
          completedAt: s.at,
          clientUpdatedAt: s.at,
        },
      },
      at: s.at,
    })),
  ];
  await applyStrengthEvents(db, USER, events);
  expect((await workoutRow(workoutId)).status).toBe("in_progress");
  return { workoutId, wxId: wx.id };
}

describe("daily job: stale in-progress sweep", () => {
  it("closes only sessions inactive for a day, keeps live ones, reverts never-performed ones", async () => {
    const db = handle.db;
    const tenMinAgo = new Date(NOW.getTime() - 10 * 60_000).toISOString();
    const halfHourAgo = new Date(NOW.getTime() - 30 * 60_000).toISOString();

    // (a) Started days ago, resumed and being logged right now: not stale.
    const resumed = await startedWorkout({
      date: OLD_DATE,
      startedAt: "2026-09-25T17:00:00.000Z",
      sets: [{ at: tenMinAgo, reps: 5, weightKg: 60 }],
    });
    // (b) A missed planned session (old plan date) started half an hour ago: not stale.
    const fresh = await startedWorkout({ date: OLD_DATE, startedAt: halfHourAgo });
    // (c) Left in progress three days ago with one set: closed at that set.
    const stale = await startedWorkout({
      date: OLD_DATE,
      startedAt: "2026-09-25T17:00:00.000Z",
      sets: [{ at: "2026-09-25T17:40:00.000Z", reps: 5, weightKg: 100 }],
    });
    // (d) Started three days ago, no set ever logged: never performed.
    const phantom = await startedWorkout({ date: OLD_DATE, startedAt: "2026-09-25T17:00:00.000Z" });

    const closed = await closeStaleInProgress(db, USER, TODAY, NOW);
    expect(closed).toBe(1);

    expect((await workoutRow(resumed.workoutId)).status).toBe("in_progress");
    expect((await workoutRow(fresh.workoutId)).status).toBe("in_progress");

    const done = await workoutRow(stale.workoutId);
    expect(done.status).toBe("done");
    expect(done.rpe).toBeNull();
    expect(done.feeling).toBeNull();
    expect(done.sessionRpeLoad).toBeNull();
    expect(done.actualDurationMin).toBe(40); // start 17:00 → last set 17:40
    expect(done.finishedAt?.toISOString()).toBe("2026-09-25T17:40:00.000Z");
    expect(await actualAnalysis(stale.workoutId)).not.toBeNull();

    const back = await workoutRow(phantom.workoutId);
    expect(back.status).toBe("planned");
    expect(back.startAt).toBeNull();
    expect(back.finishedAt).toBeNull();
    expect(back.sessionRpeLoad).toBeNull();
    expect(await actualAnalysis(phantom.workoutId)).toBeNull();
  });

  it("accepts the athlete's late finish on a system-closed session: RPE, pain, sets, analysis and PR are recomputed", async () => {
    const db = handle.db;
    const late = await startedWorkout({
      date: OLD_DATE,
      startedAt: "2026-09-25T17:00:00.000Z",
      sets: [{ at: "2026-09-25T17:20:00.000Z", reps: 5, weightKg: 110 }],
    });
    await closeStaleInProgress(db, USER, TODAY, NOW);
    const swept = await workoutRow(late.workoutId);
    expect(swept.status).toBe("done");
    expect(swept.rpe).toBeNull();
    const before = await actualAnalysis(late.workoutId);
    expect(before).not.toBeNull();
    const prsOf = async () =>
      db
        .select()
        .from(schema.personalRecords)
        .where(
          and(
            eq(schema.personalRecords.workoutId, late.workoutId),
            eq(schema.personalRecords.kind, "e1rm"),
          ),
        );
    // 110 × 5 → e1RM ≈ 128.3, above the 100 × 5 logged by the earlier sweep test on this user.
    const first = await prsOf();
    expect(first).toHaveLength(1);
    expect(first[0]?.value).toBeCloseTo(128.3, 0);

    // The phone comes back online days later: the rest of the session, then the declared finish.
    const res = await applyStrengthEvents(db, USER, [
      {
        id: nextId(),
        workoutId: late.workoutId,
        seq: 2,
        type: "set_completed",
        payload: {
          set: {
            id: nextId(),
            workoutExerciseId: late.wxId,
            setIndex: 2,
            reps: 5,
            weightKg: 130,
            completedAt: "2026-09-25T17:50:00.000Z",
            clientUpdatedAt: "2026-09-25T17:50:00.000Z",
          },
        },
        at: "2026-09-25T17:50:00.000Z",
      },
      {
        id: nextId(),
        workoutId: late.workoutId,
        seq: 3,
        type: "session_finished",
        payload: {
          finishedAt: "2026-09-25T18:00:00.000Z",
          rpe: 9,
          feeling: "too_hard",
          painReported: true,
          durationMin: 60,
        },
        at: "2026-09-25T18:00:00.000Z",
      },
    ]);
    expect(res.finishedWorkoutIds).toEqual([late.workoutId]);

    const w = await workoutRow(late.workoutId);
    expect(w.status).toBe("done");
    expect(w.rpe).toBe(9);
    expect(w.feeling).toBe("too_hard");
    expect(w.painReported).toBe(true);
    expect(w.actualDurationMin).toBe(60);
    expect(w.sessionRpeLoad).toBe(540);
    expect(w.finishedAt?.toISOString()).toBe("2026-09-25T18:00:00.000Z");
    expect(w.realisedIntensity).toBe("hard"); // lower_a is planned hard: never below the plan
    const after = await actualAnalysis(late.workoutId);
    expect(after?.heavyStrength).toBe(true);
    expect(after?.intensity).toBe("hard");
    // Two sets and RPE 9 instead of one set and no RPE: the actual load reflects the late sets.
    expect(after?.loadVector.muscular_lower).toBeGreaterThan(
      before?.loadVector.muscular_lower ?? 0,
    );
    const sets = await db
      .select()
      .from(schema.strengthSets)
      .where(eq(schema.strengthSets.workoutId, late.workoutId));
    expect(sets).toHaveLength(2);
    // The PR of this workout rose with the late set (130 × 5 → e1RM 151.7).
    const prs = await prsOf();
    expect(prs).toHaveLength(1);
    expect(prs[0]?.value).toBeCloseTo(151.7, 0);

    // Once the outcome is declared, a stray second finish is dropped as before.
    await applyStrengthEvents(db, USER, [
      {
        id: nextId(),
        workoutId: late.workoutId,
        seq: 4,
        type: "session_finished",
        payload: { finishedAt: "2026-09-26T18:00:00.000Z", rpe: 4, durationMin: 5 },
        at: "2026-09-26T18:00:00.000Z",
      },
    ]);
    expect((await workoutRow(late.workoutId)).rpe).toBe(9);
  });

  it("runDailyJobs wires the sweep with the cron instant", async () => {
    const stale = await startedWorkout({
      date: OLD_DATE,
      startedAt: "2026-09-25T18:00:00.000Z",
      sets: [{ at: "2026-09-25T18:30:00.000Z", reps: 5, weightKg: 90 }],
    });
    const live = await startedWorkout({
      date: OLD_DATE,
      startedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    });
    const summary = await runDailyJobs(handle.db, NOW);
    expect(summary.users).toBe(1);
    expect((await workoutRow(stale.workoutId)).status).toBe("done");
    expect((await workoutRow(live.workoutId)).status).toBe("in_progress");
  });
});
