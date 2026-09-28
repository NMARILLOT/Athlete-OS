import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { scoped } from "@/db/repo/scoped";
import * as schema from "@/db/schema";
import { seedCatalog, type SeedReport } from "@/db/seed";
import { createTestDb, type TestDb } from "@/db/test-db";
import { emptyLoadVector } from "@/domain/core/types";
import { runEngine } from "@/domain/engine/engine";
import { scenario } from "@/domain/engine/fixtures";

vi.mock("server-only", () => ({}));

/**
 * Database integration tests on an in-memory PGlite (ARCHITECTURE.md §2 "Tests", ADR-019):
 * migrations, deny-all RLS on every table, idempotent seed, the natural keys of DATA_MODEL.md
 * and the ownership guarantee of `scoped()`.
 */

const USER_A = "00000000-0000-4000-8000-00000000000a";
const USER_B = "00000000-0000-4000-8000-00000000000b";
const TODAY = "2026-09-28";
/** DATA_MODEL.md §1–§10 — 41 tables. */
const EXPECTED_TABLE_COUNT = 41;

let handle: TestDb;
let seeded: SeedReport;

beforeAll(async () => {
  handle = await createTestDb();
  await handle.db.insert(schema.users).values([
    { id: USER_A, email: "a@example.test", displayName: "A" },
    { id: USER_B, email: "b@example.test", displayName: "B" },
  ]);
  seeded = await seedCatalog(handle.db);
});

afterAll(async () => {
  await handle.close();
});

async function publicTables(): Promise<Array<{ name: string; rls: boolean }>> {
  return handle.db
    .select({ name: sql<string>`c.relname`, rls: sql<boolean>`c.relrowsecurity` })
    .from(sql`pg_class c join pg_namespace n on n.oid = c.relnamespace`)
    .where(sql`n.nspname = 'public' and c.relkind = 'r'`);
}

/** drizzle wraps driver errors in `DrizzleQueryError`; the Postgres error is its `cause`. */
async function expectUniqueViolation(query: PromiseLike<unknown>): Promise<void> {
  const error = await query.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  const cause = (error as Error & { cause?: { code?: string; message?: string } }).cause;
  const detail = `${cause?.code ?? ""} ${cause?.message ?? ""}`;
  expect(detail).toMatch(/23505|unique|duplicate/i);
}

async function createWorkout(userId: string, title = "Strength — Lower") {
  const [row] = await handle.db
    .insert(schema.workouts)
    .values({ userId, type: "strength", source: "planned_user", date: TODAY, title })
    .returning();
  if (!row) throw new Error("insert returned no row");
  return row;
}

describe("db schema", () => {
  it("applies the committed migrations", async () => {
    const tables = await publicTables();
    expect(tables).toHaveLength(EXPECTED_TABLE_COUNT);
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["users", "workouts", "workout_analyses", "recommendations"]),
    );
    const applied = await handle.db
      .select({ hash: sql<string>`hash` })
      .from(sql`drizzle.__drizzle_migrations`);
    expect(applied.length).toBeGreaterThanOrEqual(1);
  });

  it("enables row-level security on every public table", async () => {
    const tables = await publicTables();
    const unprotected = tables.filter((t) => !t.rls).map((t) => t.name);
    expect(unprotected).toEqual([]);
  });

  it("seeds the catalog idempotently", async () => {
    const again = await seedCatalog(handle.db);
    expect(again).toEqual(seeded);
    expect(seeded.exercises).toBe(97);
    expect(seeded.aliases).toBeGreaterThan(400);
    expect(seeded.benchmarks).toBe(8);
    expect(seeded.templates).toBe(6);
    const [fran] = await handle.db
      .select()
      .from(schema.benchmarks)
      .where(eq(schema.benchmarks.id, "fran"));
    expect(fran?.scoreKind).toBe("time");
    expect(fran?.normalizedWod?.parts[0]?.repScheme).toEqual([21, 15, 9]);
    const [lowerA] = await handle.db
      .select()
      .from(schema.workoutTemplates)
      .where(eq(schema.workoutTemplates.key, "lower_a"));
    expect(lowerA?.kind).toBe("strength");
    expect(lowerA?.expectedCredits).toEqual({ strength_lower: 1, hypertrophy: 0.5 });
  });

  it("stores planned and actual analyses and rejects a duplicate (workout_id, phase)", async () => {
    const workout = await createWorkout(USER_A);
    const base = {
      userId: USER_A,
      workoutId: workout.id,
      date: TODAY,
      loadVector: emptyLoadVector(),
      intensity: "moderate" as const,
      source: "CALCULATED",
      algorithmVersion: "test_v1",
      confidence: "HIGH" as const,
    };
    await handle.db.insert(schema.workoutAnalyses).values([
      { ...base, phase: "planned", stimulusCredits: { strength_lower: 1 } },
      { ...base, phase: "actual", stimulusCredits: { strength_lower: 0.8 } },
    ]);
    const rows = await handle.db
      .select()
      .from(schema.workoutAnalyses)
      .where(eq(schema.workoutAnalyses.workoutId, workout.id));
    expect(rows.map((r) => r.phase).sort()).toEqual(["actual", "planned"]);
    await expectUniqueViolation(
      handle.db.insert(schema.workoutAnalyses).values({ ...base, phase: "planned" }),
    );
  });

  it("upserts strength_sets by client-generated id", async () => {
    const workout = await createWorkout(USER_A);
    const [exercise] = await handle.db
      .insert(schema.workoutExercises)
      .values({
        userId: USER_A,
        workoutId: workout.id,
        date: TODAY,
        order: 0,
        exerciseId: "back_squat",
        prescription: {
          sets: 4,
          repMin: 4,
          repMax: 6,
          targetRpeMin: 7,
          targetRpeMax: 8.5,
          intent: "strength",
          loadSuggestionKg: null,
          restSec: null,
        },
      })
      .returning();
    if (!exercise) throw new Error("insert returned no row");
    const setId = crypto.randomUUID();
    const upsert = (reps: number) =>
      handle.db
        .insert(schema.strengthSets)
        .values({
          id: setId,
          userId: USER_A,
          workoutExerciseId: exercise.id,
          workoutId: workout.id,
          exerciseId: "back_squat",
          date: TODAY,
          setIndex: 0,
          reps,
          weightKg: 100,
        })
        .onConflictDoUpdate({
          target: schema.strengthSets.id,
          set: { reps, clientUpdatedAt: new Date() },
        });
    await upsert(5);
    await upsert(6);
    const rows = await handle.db
      .select()
      .from(schema.strengthSets)
      .where(eq(schema.strengthSets.workoutId, workout.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(setId);
    expect(rows[0]?.reps).toBe(6);
    expect(rows[0]?.weightKg).toBe(100);
  });

  it("keeps activities.fingerprint unique per user", async () => {
    const activity = (userId: string) => ({
      userId,
      provider: "garmin",
      fingerprint: "running|29856420",
      sport: "running",
      startAt: new Date("2026-09-28T07:00:00Z"),
      localDate: TODAY,
      durationSec: 1800,
      parserVersion: "fit_v1",
    });
    await handle.db.insert(schema.activities).values(activity(USER_A));
    await expectUniqueViolation(handle.db.insert(schema.activities).values(activity(USER_A)));
    await handle.db.insert(schema.activities).values(activity(USER_B));
    const rows = await handle.db
      .select()
      .from(schema.activities)
      .where(eq(schema.activities.fingerprint, "running|29856420"));
    expect(rows.map((r) => r.userId).sort()).toEqual([USER_A, USER_B]);
  });

  it("allows one non-superseded recommendation per (user_id, date)", async () => {
    const input = scenario();
    const recommendation = runEngine(input);
    const row = (version: number) => ({
      userId: USER_A,
      date: TODAY,
      version,
      engineVersion: recommendation.engineVersion,
      inputsSnapshot: input,
      output: recommendation,
      rulesTriggered: recommendation.rulesTriggered.map((r) => r.ruleId),
      explanation: recommendation.explanation,
      confidence: recommendation.confidence.level,
    });
    await handle.db.insert(schema.recommendations).values(row(1));
    await expectUniqueViolation(handle.db.insert(schema.recommendations).values(row(2)));
    await handle.db
      .update(schema.recommendations)
      .set({ superseded: true })
      .where(
        and(eq(schema.recommendations.userId, USER_A), eq(schema.recommendations.date, TODAY)),
      );
    await handle.db.insert(schema.recommendations).values(row(2));
    const current = await handle.db
      .select()
      .from(schema.recommendations)
      .where(
        and(
          eq(schema.recommendations.userId, USER_A),
          eq(schema.recommendations.date, TODAY),
          eq(schema.recommendations.superseded, false),
        ),
      );
    expect(current).toHaveLength(1);
    expect(current[0]?.version).toBe(2);
    expect(current[0]?.output.primary.kind).toBe(recommendation.primary.kind);
  });

  it("scoped() never leaks another user's rows", async () => {
    const a = scoped(handle.db, USER_A);
    const b = scoped(handle.db, USER_B);
    await a.insert(schema.workouts, {
      type: "cardio",
      source: "manual",
      date: TODAY,
      title: "Run A",
    });
    await b.insert(schema.workouts, [
      { type: "cardio", source: "manual", date: TODAY, title: "Run B" },
      { type: "rest", source: "manual", date: TODAY, title: "Rest B" },
    ]);

    const mine = await a.select(schema.workouts, eq(schema.workouts.type, "cardio"));
    expect(mine.map((w) => w.title)).toEqual(["Run A"]);
    expect(mine.every((w) => w.userId === USER_A)).toBe(true);

    const theirs = await b.select(schema.workouts);
    expect(theirs).toHaveLength(2);
    expect(theirs.every((w) => w.userId === USER_B)).toBe(true);

    const runB = theirs.find((w) => w.title === "Run B");
    if (!runB) throw new Error("missing Run B");
    const updated = await a
      .update(schema.workouts, { title: "Hijacked" }, eq(schema.workouts.id, runB.id))
      .returning();
    expect(updated).toHaveLength(0);
    const deleted = await a.delete(schema.workouts, eq(schema.workouts.id, runB.id)).returning();
    expect(deleted).toHaveLength(0);

    const inTx = await a.withTx(async (tx) => {
      await tx.insert(schema.workouts, {
        type: "rest",
        source: "manual",
        date: TODAY,
        title: "Rest A",
      });
      return tx.select(schema.workouts, eq(schema.workouts.type, "rest"));
    });
    expect(inTx.map((w) => w.title)).toEqual(["Rest A"]);
    const [stillB] = await b.select(schema.workouts, eq(schema.workouts.id, runB.id));
    expect(stillB?.title).toBe("Run B");
  });
});
