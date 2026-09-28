import { count, isNull, notInArray, sql } from "drizzle-orm";
import type { z } from "zod";
import { EXERCISE_CATALOG } from "../domain/exercises/catalog";
import { listAliasPairs } from "../domain/exercises/resolver";
import { STRENGTH_TEMPLATES } from "../domain/strength/templates";
import { NormalizedWodSchema, type NormalizedWod } from "../domain/wod/schema";
import type { Db } from "./client";
import {
  benchmarks,
  exerciseAliases,
  exercises,
  workoutTemplates,
  type BenchmarkScoreKind,
} from "./schema";

/**
 * Reference data seed (DATA_MODEL.md §2, §3, §7). Idempotent: every row has a natural key and is
 * written with `ON CONFLICT DO UPDATE`, so re-running after a catalog change converges.
 */

export interface SeedReport {
  exercises: number;
  aliases: number;
  benchmarks: number;
  templates: number;
}

/** `excluded."<column>"` for `ON CONFLICT DO UPDATE` sets. */
const excluded = (column: string) => sql.raw(`excluded."${column}"`);

const SEED_PARSER_VERSION = "seed_v1";

type WodInput = z.input<typeof NormalizedWodSchema>;
type WodPartInput = WodInput["parts"][number];
type WodMovementInput = WodPartInput["movements"][number];

interface BenchmarkSeed {
  id: string;
  name: string;
  kind: "girl" | "hero";
  description: string;
  scoreKind: BenchmarkScoreKind;
  wod: NormalizedWod;
}

/** Shorthand for a resolved catalog movement inside a seeded benchmark. */
function movement(
  raw: string,
  exerciseId: string,
  extra: Partial<{
    reps: number;
    distanceM: number;
    load: { value: number; unit: "kg"; alt: number | null };
  }> = {},
): WodMovementInput {
  return { raw, exerciseId, name: raw, ...extra };
}

function wod(title: string, sourceText: string, part: Omit<WodPartInput, "kind">): NormalizedWod {
  return NormalizedWodSchema.parse({
    title,
    sourceText,
    parts: [{ kind: "metcon", ...part }],
    parseConfidence: 1,
    parser: "USER",
    parserVersion: SEED_PARSER_VERSION,
  });
}

const kg = (value: number, alt: number | null = null) => ({ value, unit: "kg" as const, alt });

/** Classic benchmarks (girls + Murph). Loads are Rx men/women in kg. */
export const BENCHMARK_WODS: readonly BenchmarkSeed[] = [
  {
    id: "fran",
    name: "Fran",
    kind: "girl",
    description: "21-15-9 thrusters (43/30 kg) and pull-ups, for time.",
    scoreKind: "time",
    wod: wod("Fran", "21-15-9\nThrusters 43/30 kg\nPull-ups", {
      format: "for_time",
      repScheme: [21, 15, 9],
      movements: [
        movement("Thrusters", "thruster", { load: kg(43, 30) }),
        movement("Pull-ups", "pull_up"),
      ],
    }),
  },
  {
    id: "grace",
    name: "Grace",
    kind: "girl",
    description: "30 clean and jerks (61/43 kg), for time.",
    scoreKind: "time",
    wod: wod("Grace", "30 clean and jerks 61/43 kg for time", {
      format: "for_time",
      movements: [movement("Clean and jerks", "clean_and_jerk", { reps: 30, load: kg(61, 43) })],
    }),
  },
  {
    id: "diane",
    name: "Diane",
    kind: "girl",
    description: "21-15-9 deadlifts (102/70 kg) and handstand push-ups, for time.",
    scoreKind: "time",
    wod: wod("Diane", "21-15-9\nDeadlifts 102/70 kg\nHandstand push-ups", {
      format: "for_time",
      repScheme: [21, 15, 9],
      movements: [
        movement("Deadlifts", "deadlift", { load: kg(102, 70) }),
        movement("Handstand push-ups", "handstand_push_up"),
      ],
    }),
  },
  {
    id: "helen",
    name: "Helen",
    kind: "girl",
    description: "3 rounds: 400 m run, 21 kettlebell swings (24/16 kg), 12 pull-ups, for time.",
    scoreKind: "time",
    wod: wod("Helen", "3 rounds for time\n400 m run\n21 KB swings 24/16 kg\n12 pull-ups", {
      format: "for_time",
      rounds: 3,
      movements: [
        movement("Run", "run", { distanceM: 400 }),
        movement("Kettlebell swings", "kettlebell_swing", { reps: 21, load: kg(24, 16) }),
        movement("Pull-ups", "pull_up", { reps: 12 }),
      ],
    }),
  },
  {
    id: "murph",
    name: "Murph",
    kind: "hero",
    description:
      "1 mile run, 100 pull-ups, 200 push-ups, 300 air squats, 1 mile run, for time (20/14 lb vest).",
    scoreKind: "time",
    wod: wod(
      "Murph",
      "For time\n1 mile run\n100 pull-ups\n200 push-ups\n300 squats\n1 mile run\nWith a 20/14 lb vest",
      {
        format: "chipper",
        movements: [
          movement("Run", "run", { distanceM: 1609 }),
          movement("Pull-ups", "pull_up", { reps: 100 }),
          movement("Push-ups", "push_up", { reps: 200 }),
          movement("Air squats", "air_squat", { reps: 300 }),
          movement("Run", "run", { distanceM: 1609 }),
        ],
        notes: "Partition the pull-ups, push-ups and squats as needed. 20/14 lb vest if Rx.",
      },
    ),
  },
  {
    id: "cindy",
    name: "Cindy",
    kind: "girl",
    description: "AMRAP 20 min: 5 pull-ups, 10 push-ups, 15 air squats.",
    scoreKind: "rounds_reps",
    wod: wod("Cindy", "AMRAP 20\n5 pull-ups\n10 push-ups\n15 squats", {
      format: "amrap",
      durationMin: 20,
      movements: [
        movement("Pull-ups", "pull_up", { reps: 5 }),
        movement("Push-ups", "push_up", { reps: 10 }),
        movement("Air squats", "air_squat", { reps: 15 }),
      ],
    }),
  },
  {
    id: "annie",
    name: "Annie",
    kind: "girl",
    description: "50-40-30-20-10 double-unders and sit-ups, for time.",
    scoreKind: "time",
    wod: wod("Annie", "50-40-30-20-10\nDouble-unders\nSit-ups", {
      format: "for_time",
      repScheme: [50, 40, 30, 20, 10],
      movements: [movement("Double-unders", "double_under"), movement("Sit-ups", "sit_up")],
    }),
  },
  {
    id: "karen",
    name: "Karen",
    kind: "girl",
    description: "150 wall balls (9/6 kg), for time.",
    scoreKind: "time",
    wod: wod("Karen", "150 wall balls 9/6 kg for time", {
      format: "for_time",
      movements: [movement("Wall balls", "wall_ball", { reps: 150, load: kg(9, 6) })],
    }),
  },
];

async function seedExercises(db: Db): Promise<void> {
  const rows = EXERCISE_CATALOG.map((ex) => ({
    id: ex.id,
    name: ex.name,
    category: ex.category,
    movementPattern: ex.movementPattern,
    secondaryPatterns: [...(ex.secondaryPatterns ?? [])],
    primaryMuscles: [...ex.primaryMuscles],
    secondaryMuscles: [...(ex.secondaryMuscles ?? [])],
    equipment: [...ex.equipment],
    measurementType: ex.measurementType,
    defaultIncrementKg: ex.defaultIncrementKg ?? null,
    technicalDifficulty: ex.technicalDifficulty,
    impactLevel: ex.impactLevel,
    eccentricLoad: ex.eccentricLoad,
    modality: ex.modality ?? null,
    isBenchmarkLift: ex.isBenchmarkLift ?? false,
    cost: ex.cost,
    userId: null,
  }));
  await db
    .insert(exercises)
    .values(rows)
    .onConflictDoUpdate({
      target: exercises.id,
      set: {
        name: excluded("name"),
        category: excluded("category"),
        movementPattern: excluded("movement_pattern"),
        secondaryPatterns: excluded("secondary_patterns"),
        primaryMuscles: excluded("primary_muscles"),
        secondaryMuscles: excluded("secondary_muscles"),
        equipment: excluded("equipment"),
        measurementType: excluded("measurement_type"),
        defaultIncrementKg: excluded("default_increment_kg"),
        technicalDifficulty: excluded("technical_difficulty"),
        impactLevel: excluded("impact_level"),
        eccentricLoad: excluded("eccentric_load"),
        modality: excluded("modality"),
        isBenchmarkLift: excluded("is_benchmark_lift"),
        cost: excluded("cost"),
        updatedAt: sql`now()`,
      },
    });
}

async function seedAliases(db: Db): Promise<void> {
  const pairs = listAliasPairs();
  const rows = pairs.map(([alias, exerciseId]) => ({ alias, exerciseId, userId: null }));
  await db
    .insert(exerciseAliases)
    .values(rows)
    .onConflictDoUpdate({
      target: [exerciseAliases.alias],
      targetWhere: isNull(exerciseAliases.userId),
      set: { exerciseId: excluded("exercise_id") },
    });
  // Global aliases dropped from the catalog disappear; user aliases are untouched.
  await db.delete(exerciseAliases).where(
    sql`${isNull(exerciseAliases.userId)} and ${notInArray(
      exerciseAliases.alias,
      pairs.map(([alias]) => alias),
    )}`,
  );
}

async function seedBenchmarks(db: Db): Promise<void> {
  await db
    .insert(benchmarks)
    .values(
      BENCHMARK_WODS.map((b) => ({
        id: b.id,
        name: b.name,
        kind: b.kind,
        description: b.description,
        scoreKind: b.scoreKind,
        normalizedWod: b.wod,
        userId: null,
      })),
    )
    .onConflictDoUpdate({
      target: benchmarks.id,
      set: {
        name: excluded("name"),
        kind: excluded("kind"),
        description: excluded("description"),
        scoreKind: excluded("score_kind"),
        normalizedWod: excluded("normalized_wod"),
        updatedAt: sql`now()`,
      },
    });
}

async function seedTemplates(db: Db): Promise<void> {
  await db
    .insert(workoutTemplates)
    .values(
      STRENGTH_TEMPLATES.map((t) => ({
        key: t.id,
        kind: "strength",
        name: t.name,
        body: t,
        expectedCredits: t.expectedCredits,
        expectedLoad: t.loadVector,
        expectedRpe: null,
        defaultDurationMin: t.durationMin,
        intensity: t.intensity,
        userId: null,
      })),
    )
    .onConflictDoUpdate({
      target: [workoutTemplates.userId, workoutTemplates.key],
      set: {
        kind: excluded("kind"),
        name: excluded("name"),
        body: excluded("body"),
        expectedCredits: excluded("expected_credits"),
        expectedLoad: excluded("expected_load"),
        defaultDurationMin: excluded("default_duration_min"),
        intensity: excluded("intensity"),
        updatedAt: sql`now()`,
      },
    });
}

async function countRows(db: Db): Promise<SeedReport> {
  const [ex] = await db.select({ n: count() }).from(exercises).where(isNull(exercises.userId));
  const [al] = await db
    .select({ n: count() })
    .from(exerciseAliases)
    .where(isNull(exerciseAliases.userId));
  const [be] = await db.select({ n: count() }).from(benchmarks).where(isNull(benchmarks.userId));
  const [te] = await db
    .select({ n: count() })
    .from(workoutTemplates)
    .where(isNull(workoutTemplates.userId));
  return {
    exercises: ex?.n ?? 0,
    aliases: al?.n ?? 0,
    benchmarks: be?.n ?? 0,
    templates: te?.n ?? 0,
  };
}

/**
 * Upsert the exercise catalog, its aliases, the benchmark WODs and the strength templates.
 * Safe to call on every boot of a dev database and from tests.
 */
export async function seedCatalog(db: Db): Promise<SeedReport> {
  await seedExercises(db);
  await seedAliases(db);
  await seedBenchmarks(db);
  await seedTemplates(db);
  return countRows(db);
}
