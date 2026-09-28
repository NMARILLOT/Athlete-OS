import "server-only";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  clientEvents,
  personalRecords,
  strengthSets,
  userPreferences,
  workoutAnalyses,
  workoutExercises,
  workouts,
} from "@/db/schema";
import {
  E1RM_ALGORITHM_VERSION,
  STRENGTH_TEMPLATES,
  StrengthPrescriptionSchema,
  bestE1rm,
  estimateOneRepMax,
  type SetQuality,
  type StrengthPrescription,
} from "@/domain/strength";
import { getExercise } from "@/domain/exercises";
import { isHeavyStrengthSession, sessionRpeLoad } from "@/domain/load";
import { toConfidence, type Feeling } from "@/domain/core";
import type { IsoDate as IsoDateT } from "@/domain/core/dates";
import { NotFoundError, ValidationError } from "@/server/errors";
import { log } from "@/server/logging";
import { z } from "zod";
import { analysisRowFromProfile } from "./workout.service";
import { profileOfKind } from "@/domain/engine/fixtures";

export interface StrengthBundleExercise {
  id: string;
  exerciseId: string;
  name: string;
  order: number;
  prescription: StrengthPrescription;
  incrementKg: number;
  lastExposure: {
    date: string;
    sets: Array<{
      reps: number;
      weightKg: number;
      rpe?: number | null;
      quality?: SetQuality | null;
    }>;
  } | null;
  bestE1rmKg: number | null;
  alternates: string[];
}

export interface StrengthBundle {
  workoutId: string;
  title: string;
  date: IsoDateT;
  templateId: string | null;
  status: string;
  exercises: StrengthBundleExercise[];
}

function incrementFor(
  exerciseId: string,
  prefs: typeof userPreferences.$inferSelect | undefined,
): number {
  const ex = getExercise(exerciseId);
  if (!ex) return 2.5;
  if (ex.category === "dumbbell" || ex.category === "kettlebell")
    return prefs?.dumbbellIncrementKg ?? ex.defaultIncrementKg ?? 2;
  if (ex.category === "machine") return prefs?.machineIncrementKg ?? ex.defaultIncrementKg ?? 2.5;
  return prefs?.barbellIncrementKg ?? ex.defaultIncrementKg ?? 2.5;
}

/** Best e1RM per exercise over the last 90 days (for WOD analysis %1RM and autoload seeding). */
export async function bestE1rmsByExercise(db: Db, userId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ exerciseId: strengthSets.exerciseId, best: sql<number>`max(${strengthSets.e1rmKg})` })
    .from(strengthSets)
    .where(
      and(
        eq(strengthSets.userId, userId),
        eq(strengthSets.isWarmup, false),
        sql`${strengthSets.e1rmKg} is not null`,
      ),
    )
    .groupBy(strengthSets.exerciseId);
  const out: Record<string, number> = {};
  for (const r of rows) if (r.best != null) out[r.exerciseId] = Number(r.best);
  // Declared PRs (onboarding "niveau / PR") seed exercises without any logged set — never override
  // a measured e1RM (spec §70: declared ≠ measured).
  for (const [exerciseId, kg] of Object.entries(await declaredE1rms(db, userId)))
    if (out[exerciseId] == null) out[exerciseId] = kg;
  return out;
}

/** Declared 1RM / e1RM records (`personal_records`, source USER or CALCULATED) as an e1RM per exercise. */
async function declaredE1rms(
  db: Db,
  userId: string,
  exerciseIds?: string[],
): Promise<Record<string, number>> {
  if (exerciseIds && exerciseIds.length === 0) return {};
  const rows = await db
    .select({
      exerciseId: personalRecords.exerciseId,
      kind: personalRecords.kind,
      value: personalRecords.value,
      reps: personalRecords.reps,
    })
    .from(personalRecords)
    .where(
      and(
        eq(personalRecords.userId, userId),
        eq(personalRecords.superseded, false),
        inArray(personalRecords.kind, ["weight", "e1rm"]),
        sql`${personalRecords.exerciseId} is not null`,
        ...(exerciseIds ? [inArray(personalRecords.exerciseId, exerciseIds)] : []),
      ),
    );
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (!r.exerciseId) continue;
    const e1rm = r.kind === "e1rm" ? r.value : (estimateOneRepMax(r.value, r.reps ?? 1) ?? r.value);
    if (out[r.exerciseId] == null || e1rm > (out[r.exerciseId] as number))
      out[r.exerciseId] = Math.round(e1rm * 2) / 2;
  }
  return out;
}

/** Bundle for the client-only strength shell (ARCHITECTURE §4): prescriptions + history snapshot + increments. */
export async function getStrengthBundle(
  db: Db,
  userId: string,
  workoutId: string,
): Promise<StrengthBundle> {
  const [w] = await db
    .select()
    .from(workouts)
    .where(and(eq(workouts.id, workoutId), eq(workouts.userId, userId)))
    .limit(1);
  if (!w) throw new NotFoundError("Séance");
  const exRows = await db
    .select()
    .from(workoutExercises)
    .where(and(eq(workoutExercises.workoutId, w.id), eq(workoutExercises.userId, userId)))
    .orderBy(workoutExercises.order);
  const [prefs] = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  const exerciseIds = [...new Set(exRows.map((e) => e.exerciseId))];
  const history = exerciseIds.length
    ? await db
        .select()
        .from(strengthSets)
        .where(
          and(
            eq(strengthSets.userId, userId),
            inArray(strengthSets.exerciseId, exerciseIds),
            eq(strengthSets.isWarmup, false),
            sql`${strengthSets.workoutId} <> ${w.id}`,
          ),
        )
        .orderBy(desc(strengthSets.completedAt))
        .limit(400)
    : [];
  const template = w.templateId ? STRENGTH_TEMPLATES.find((t) => t.id === w.templateId) : undefined;
  const declared = await declaredE1rms(db, userId, exerciseIds);
  const exercises: StrengthBundleExercise[] = exRows.map((e) => {
    const sets = history.filter((s) => s.exerciseId === e.exerciseId);
    const lastDate = sets[0]?.date ?? null;
    const lastSets = lastDate
      ? sets
          .filter((s) => s.date === lastDate && s.reps != null && s.weightKg != null)
          .map((s) => ({
            reps: s.reps as number,
            weightKg: s.weightKg as number,
            rpe: s.rpe,
            quality: s.quality,
          }))
      : [];
    const best = bestE1rm(
      sets
        .filter((s) => s.reps != null && s.weightKg != null)
        .map((s) => ({ weightKg: s.weightKg as number, reps: s.reps as number, rpe: s.rpe })),
    );
    const parsed = StrengthPrescriptionSchema.safeParse(e.prescription);
    const prescription: StrengthPrescription = parsed.success
      ? parsed.data
      : {
          sets: 3,
          repMin: 8,
          repMax: 12,
          targetRpeMin: 7,
          targetRpeMax: 8.5,
          intent: "hypertrophy",
          loadSuggestionKg: null,
          restSec: null,
        };
    return {
      id: e.id,
      exerciseId: e.exerciseId,
      name: getExercise(e.exerciseId)?.name ?? e.exerciseId,
      order: e.order,
      prescription,
      incrementKg: incrementFor(e.exerciseId, prefs),
      lastExposure: lastDate ? { date: lastDate, sets: lastSets.reverse() } : null,
      bestE1rmKg: best?.e1rmKg ?? declared[e.exerciseId] ?? null,
      alternates: template?.exercises.find((t) => t.exerciseId === e.exerciseId)?.alternates ?? [],
    };
  });
  return {
    workoutId: w.id,
    title: w.title,
    date: w.date,
    templateId: w.templateId,
    status: w.status,
    exercises,
  };
}

/** Start an ad-hoc strength session from a template kind (Train → Strength). */
export async function createStrengthWorkoutFromTemplate(
  db: Db,
  userId: string,
  opts: { templateId: string; date: IsoDateT; workoutId?: string },
): Promise<{ workoutId: string }> {
  const template = STRENGTH_TEMPLATES.find((t) => t.id === opts.templateId);
  if (!template) throw new ValidationError("Template inconnu");
  const [w] = await db
    .insert(workouts)
    .values({
      id: opts.workoutId,
      userId,
      type: "strength",
      source: "planned_user",
      status: "planned",
      date: opts.date,
      plannedDurationMin: template.durationMin,
      title: template.name,
      plannedIntensity: template.intensity,
      intensitySource: "ENGINE",
      fixed: false,
      expectedRpe: 7.5,
    })
    .returning({ id: workouts.id });
  if (!w) throw new Error("workout insert failed");
  await db.insert(workoutExercises).values(
    template.exercises.map((ex, i) => ({
      userId,
      workoutId: w.id,
      date: opts.date,
      order: i,
      exerciseId: ex.exerciseId,
      prescription: ex.prescription,
      source: "ENGINE",
    })),
  );
  const profile = profileOfKind(template.kind);
  await db
    .insert(workoutAnalyses)
    .values({
      userId,
      workoutId: w.id,
      phase: "planned",
      date: opts.date,
      ...analysisRowFromProfile(
        { ...profile, durationMin: template.durationMin },
        "ENGINE",
        "strength_template_v1",
        1,
        template.id,
      ),
    })
    .onConflictDoNothing();
  return { workoutId: w.id };
}

// ---------------------------------------------------------------------------
// Outbox events (POST /api/sync/strength)
// ---------------------------------------------------------------------------

const SetPayload = z.object({
  id: z.string().uuid(),
  workoutExerciseId: z.string().uuid(),
  exerciseId: z.string().nullable().optional(),
  setIndex: z.number().int().min(0),
  reps: z.number().int().min(0),
  weightKg: z.number().min(0),
  quality: z.enum(["easy", "perfect", "hard", "failed"]).nullable().optional(),
  rpe: z.number().min(1).max(10).nullable().optional(),
  isWarmup: z.boolean().optional(),
  completedAt: z.string(),
  clientUpdatedAt: z.string(),
  e1rmKg: z.number().nullable().optional(),
});

export const OutboxEventSchema = z.object({
  id: z.string().uuid(),
  workoutId: z.string().uuid(),
  seq: z.number().int().min(0),
  type: z.enum([
    "session_started",
    "set_completed",
    "set_updated",
    "set_deleted",
    "exercise_added",
    "exercise_swapped",
    "session_finished",
  ]),
  payload: z.record(z.string(), z.unknown()),
  at: z.string(),
});
export type OutboxEventInput = z.infer<typeof OutboxEventSchema>;

/**
 * Apply a batch of client events in order, idempotently (client_events unique id), scoped to the
 * user's own workout. Returns acknowledged event ids (including already-applied ones).
 */
export async function applyStrengthEvents(
  db: Db,
  userId: string,
  events: OutboxEventInput[],
): Promise<{ acknowledged: string[]; finishedWorkoutIds: string[] }> {
  const acknowledged: string[] = [];
  const finished: string[] = [];
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  for (const ev of sorted) {
    const [already] = await db
      .select({ id: clientEvents.id })
      .from(clientEvents)
      .where(eq(clientEvents.id, ev.id))
      .limit(1);
    if (already) {
      acknowledged.push(ev.id);
      continue;
    }
    const [w] = await db
      .select()
      .from(workouts)
      .where(and(eq(workouts.id, ev.workoutId), eq(workouts.userId, userId)))
      .limit(1);
    if (!w && ev.type !== "session_started") {
      log.warn("sync.strength.unknown_workout", { userId, workoutId: ev.workoutId, kind: ev.type });
      acknowledged.push(ev.id); // drop orphan events rather than blocking the outbox forever
      continue;
    }
    await db.transaction(async (tx) => {
      switch (ev.type) {
        case "session_started": {
          const p = ev.payload as {
            date?: string;
            title?: string;
            templateId?: string | null;
            startedAt?: string;
            exercises?: Array<{
              id: string;
              exerciseId: string;
              order: number;
              prescription: unknown;
            }>;
          };
          if (!w) {
            await tx
              .insert(workouts)
              .values({
                id: ev.workoutId,
                userId,
                type: "strength",
                source: "planned_user",
                status: "in_progress",
                date: p.date ?? ev.at.slice(0, 10),
                title: p.title ?? "Strength",
                plannedIntensity: "moderate",
                intensitySource: "USER",
                startAt: p.startedAt ? new Date(p.startedAt) : new Date(ev.at),
                templateId: p.templateId ?? null,
              })
              .onConflictDoNothing();
            for (const ex of p.exercises ?? []) {
              const pr = StrengthPrescriptionSchema.safeParse(ex.prescription);
              await tx
                .insert(workoutExercises)
                .values({
                  id: ex.id,
                  userId,
                  workoutId: ev.workoutId,
                  date: p.date ?? ev.at.slice(0, 10),
                  order: ex.order,
                  exerciseId: ex.exerciseId,
                  prescription: pr.success
                    ? pr.data
                    : {
                        sets: 3,
                        repMin: 8,
                        repMax: 12,
                        targetRpeMin: 7,
                        targetRpeMax: 8.5,
                        intent: "hypertrophy",
                        loadSuggestionKg: null,
                        restSec: null,
                      },
                  source: "USER",
                })
                .onConflictDoNothing();
            }
          } else {
            await tx
              .update(workouts)
              .set({ status: "in_progress", startAt: w.startAt ?? new Date(p.startedAt ?? ev.at) })
              .where(eq(workouts.id, w.id));
          }
          break;
        }
        case "set_completed": {
          const parsed = SetPayload.safeParse(ev.payload.set);
          if (!parsed.success || !w) break;
          const s = parsed.data;
          const [wx] = await tx
            .select({ id: workoutExercises.id, exerciseId: workoutExercises.exerciseId })
            .from(workoutExercises)
            .where(
              and(
                eq(workoutExercises.id, s.workoutExerciseId),
                eq(workoutExercises.userId, userId),
                eq(workoutExercises.workoutId, w.id),
              ),
            )
            .limit(1);
          if (!wx) break;
          const e1rm = s.isWarmup ? null : estimateOneRepMax(s.weightKg, s.reps);
          await tx
            .insert(strengthSets)
            .values({
              id: s.id,
              userId,
              workoutId: w.id,
              workoutExerciseId: wx.id,
              exerciseId: wx.exerciseId,
              date: w.date,
              setIndex: s.setIndex,
              reps: s.reps,
              weightKg: s.weightKg,
              rpe: s.rpe ?? null,
              quality: s.quality ?? null,
              isWarmup: s.isWarmup ?? false,
              completedAt: new Date(s.completedAt),
              clientUpdatedAt: new Date(s.clientUpdatedAt),
              e1rmKg: e1rm,
              e1rmVersion: e1rm != null ? E1RM_ALGORITHM_VERSION : null,
            })
            .onConflictDoUpdate({
              target: strengthSets.id,
              set: {
                reps: s.reps,
                weightKg: s.weightKg,
                rpe: s.rpe ?? null,
                quality: s.quality ?? null,
                setIndex: s.setIndex,
                clientUpdatedAt: new Date(s.clientUpdatedAt),
                e1rmKg: e1rm,
              },
            });
          break;
        }
        case "set_updated": {
          const p = ev.payload as {
            setId?: string;
            reps?: number;
            weightKg?: number;
            rpe?: number | null;
            quality?: SetQuality | null;
            clientUpdatedAt?: string;
          };
          if (!p.setId || !w) break;
          const [existing] = await tx
            .select()
            .from(strengthSets)
            .where(and(eq(strengthSets.id, p.setId), eq(strengthSets.userId, userId)))
            .limit(1);
          if (!existing) break;
          const incoming = p.clientUpdatedAt ? new Date(p.clientUpdatedAt) : new Date(ev.at);
          if (incoming < existing.clientUpdatedAt) break; // last-write-wins
          const reps = p.reps ?? existing.reps;
          const weightKg = p.weightKg ?? existing.weightKg;
          const e1rm =
            !existing.isWarmup && reps != null && weightKg != null
              ? estimateOneRepMax(weightKg, reps)
              : existing.e1rmKg;
          await tx
            .update(strengthSets)
            .set({
              reps,
              weightKg,
              rpe: p.rpe === undefined ? existing.rpe : p.rpe,
              quality: p.quality === undefined ? existing.quality : p.quality,
              clientUpdatedAt: incoming,
              e1rmKg: e1rm,
            })
            .where(eq(strengthSets.id, existing.id));
          break;
        }
        case "set_deleted": {
          const p = ev.payload as { setId?: string };
          if (p.setId)
            await tx
              .delete(strengthSets)
              .where(and(eq(strengthSets.id, p.setId), eq(strengthSets.userId, userId)));
          break;
        }
        case "exercise_swapped": {
          const p = ev.payload as { workoutExerciseId?: string; exerciseId?: string };
          if (p.workoutExerciseId && p.exerciseId && getExercise(p.exerciseId))
            await tx
              .update(workoutExercises)
              .set({ exerciseId: p.exerciseId })
              .where(
                and(
                  eq(workoutExercises.id, p.workoutExerciseId),
                  eq(workoutExercises.userId, userId),
                ),
              );
          break;
        }
        case "exercise_added": {
          const p = ev.payload as {
            id?: string;
            exerciseId?: string;
            order?: number;
            prescription?: unknown;
          };
          if (!w || !p.id || !p.exerciseId || !getExercise(p.exerciseId)) break;
          const pr = StrengthPrescriptionSchema.safeParse(p.prescription);
          await tx
            .insert(workoutExercises)
            .values({
              id: p.id,
              userId,
              workoutId: w.id,
              date: w.date,
              order: p.order ?? 99,
              exerciseId: p.exerciseId,
              prescription: pr.success
                ? pr.data
                : {
                    sets: 3,
                    repMin: 8,
                    repMax: 12,
                    targetRpeMin: 7,
                    targetRpeMax: 8.5,
                    intent: "hypertrophy",
                    loadSuggestionKg: null,
                    restSec: null,
                  },
              source: "USER",
            })
            .onConflictDoNothing();
          break;
        }
        case "session_finished": {
          if (!w) break;
          const p = ev.payload as {
            finishedAt?: string;
            rpe?: number | null;
            feeling?: Feeling | null;
            painReported?: boolean;
            notes?: string;
            durationMin?: number;
          };
          const finishedAt = p.finishedAt ? new Date(p.finishedAt) : new Date(ev.at);
          const durationMin =
            p.durationMin ??
            Math.max(
              1,
              Math.round((finishedAt.getTime() - (w.startAt ?? finishedAt).getTime()) / 60000),
            );
          await finishStrengthWorkout(tx as unknown as Db, userId, {
            workout: w,
            finishedAt,
            durationMin,
            rpe: p.rpe ?? null,
            feeling: p.feeling ?? null,
            painReported: p.painReported ?? false,
            notes: p.notes ?? "",
          });
          finished.push(w.id);
          break;
        }
      }
      await tx
        .insert(clientEvents)
        .values({ id: ev.id, userId, workoutId: ev.workoutId, seq: ev.seq, type: ev.type })
        .onConflictDoNothing();
    });
    acknowledged.push(ev.id);
  }
  return { acknowledged, finishedWorkoutIds: [...new Set(finished)] };
}

/** Finish: session-RPE load, actual analysis from performed sets, e1RM PRs. */
async function finishStrengthWorkout(
  db: Db,
  userId: string,
  opts: {
    workout: typeof workouts.$inferSelect;
    finishedAt: Date;
    durationMin: number;
    rpe: number | null;
    feeling: Feeling | null;
    painReported: boolean;
    notes: string;
  },
): Promise<void> {
  const w = opts.workout;
  const sets = await db
    .select()
    .from(strengthSets)
    .where(and(eq(strengthSets.workoutId, w.id), eq(strengthSets.userId, userId)));
  const heavy = isHeavyStrengthSession(
    sets.map((s) => ({ rpe: s.rpe, quality: s.quality, isWarmup: s.isWarmup })),
  );
  await db
    .update(workouts)
    .set({
      status: "done",
      finishedAt: opts.finishedAt,
      actualDurationMin: opts.durationMin,
      rpe: opts.rpe,
      feeling: opts.feeling,
      painReported: opts.painReported,
      notes: opts.notes,
      sessionRpeLoad: sessionRpeLoad(opts.durationMin, opts.rpe),
      realisedIntensity: heavy ? "moderate" : "easy",
      intensitySource: "CALCULATED",
    })
    .where(eq(workouts.id, w.id));

  // Actual analysis: planned profile scaled by performed volume (sets done / sets planned) and RPE.
  const [planned] = await db
    .select()
    .from(workoutAnalyses)
    .where(and(eq(workoutAnalyses.workoutId, w.id), eq(workoutAnalyses.phase, "planned")))
    .limit(1);
  const exRows = await db
    .select()
    .from(workoutExercises)
    .where(eq(workoutExercises.workoutId, w.id));
  const plannedSets =
    exRows.reduce(
      (a, e) => a + (StrengthPrescriptionSchema.safeParse(e.prescription).data?.sets ?? 3),
      0,
    ) || 1;
  const doneSets = sets.filter((s) => !s.isWarmup).length;
  const volumeFactor = Math.min(1.3, Math.max(0.3, doneSets / plannedSets));
  const rpeFactor =
    opts.rpe != null && w.expectedRpe ? Math.min(1.4, Math.max(0.6, opts.rpe / w.expectedRpe)) : 1;
  const base = planned ?? null;
  const loadVector = base
    ? Object.fromEntries(
        Object.entries(base.loadVector).map(([k, v]) => [
          k,
          Math.round(v * volumeFactor * rpeFactor * 100) / 100,
        ]),
      )
    : {
        cardiovascular: 2,
        muscular_lower: heavy ? 5 : 3,
        muscular_upper: heavy ? 5 : 3,
        impact: 0,
        eccentric: 4,
        technical: 2,
      };
  const credits = base
    ? Object.fromEntries(
        Object.entries(base.stimulusCredits).map(([k, v]) => [
          k,
          Math.round(v * volumeFactor * 100) / 100,
        ]),
      )
    : { strength_upper: 0.5, strength_lower: 0.5 };
  await db
    .insert(workoutAnalyses)
    .values({
      userId,
      workoutId: w.id,
      phase: "actual",
      date: w.date,
      stimulusCredits: credits,
      loadVector: loadVector as (typeof workoutAnalyses.$inferInsert)["loadVector"],
      patternExposure: base?.patternExposure ?? {},
      muscleExposure: base?.muscleExposure ?? {},
      energySystems: ["phosphagen"],
      impactUnits: 0,
      intensity: heavy ? "moderate" : "easy",
      heavyStrength: heavy,
      source: "CALCULATED",
      inputRef: base?.inputRef ?? null,
      algorithmVersion: "strength_actual_v1",
      confidence: toConfidence(opts.rpe != null ? 0.9 : 0.6),
    })
    .onConflictDoUpdate({
      target: [workoutAnalyses.workoutId, workoutAnalyses.phase],
      set: {
        stimulusCredits: credits,
        loadVector: loadVector as (typeof workoutAnalyses.$inferInsert)["loadVector"],
        heavyStrength: heavy,
        computedAt: new Date(),
      },
    });

  // e1RM PR detection (estimated, version-pinned): compare best set e1RM to the best before this workout.
  const byExercise = new Map<string, typeof sets>();
  for (const s of sets)
    if (!s.isWarmup && s.e1rmKg != null)
      byExercise.set(s.exerciseId, [...(byExercise.get(s.exerciseId) ?? []), s]);
  for (const [exerciseId, list] of byExercise) {
    const best = list.reduce((m, s) => ((s.e1rmKg ?? 0) > (m.e1rmKg ?? 0) ? s : m));
    const [prev] = await db
      .select({ best: sql<number>`max(${strengthSets.e1rmKg})` })
      .from(strengthSets)
      .where(
        and(
          eq(strengthSets.userId, userId),
          eq(strengthSets.exerciseId, exerciseId),
          sql`${strengthSets.workoutId} <> ${w.id}`,
          gte(strengthSets.completedAt, new Date(0)),
        ),
      );
    const previous = prev?.best != null ? Number(prev.best) : null;
    if (best.e1rmKg != null && (previous === null || best.e1rmKg > previous)) {
      await db
        .insert(personalRecords)
        .values({
          userId,
          kind: "e1rm",
          exerciseId,
          value: best.e1rmKg,
          unit: "kg",
          reps: best.reps,
          achievedAt: best.completedAt,
          workoutId: w.id,
          source: "CALCULATED",
          estimated: true,
          algorithmVersion: E1RM_ALGORITHM_VERSION,
          previousValue: previous,
        })
        .onConflictDoNothing();
      log.info("pr.detected", { userId, workoutId: w.id, kind: "e1rm" });
    }
  }
}
