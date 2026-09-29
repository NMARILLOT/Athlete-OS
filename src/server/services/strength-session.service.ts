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
import {
  FEELING_VALUES,
  INTENSITY_BAND_VALUES,
  toConfidence,
  type Feeling,
  type IntensityBand,
  type WorkoutStatus,
} from "@/domain/core";
import type { IsoDate as IsoDateT } from "@/domain/core/dates";
import { NotFoundError, ValidationError } from "@/server/errors";
import { log } from "@/server/logging";
import { z } from "zod";
import { analysisRowFromProfile, realisedBandFromFeedback } from "./workout.service";
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

/** A set of *this* workout already on the server replica (to resume when IndexedDB is empty). */
export interface StrengthBundleSet {
  id: string;
  workoutExerciseId: string;
  setIndex: number;
  reps: number;
  weightKg: number;
  quality: SetQuality | null;
  rpe: number | null;
  isWarmup: boolean;
  completedAt: string;
  clientUpdatedAt: string;
}

export interface StrengthBundle {
  workoutId: string;
  title: string;
  date: IsoDateT;
  templateId: string | null;
  status: WorkoutStatus;
  /** Server-side start of the session (`workouts.start_at`), when it was started. */
  startedAt: string | null;
  exercises: StrengthBundleExercise[];
  /** Sets already synced for this workout (ARCHITECTURE §4.2: replica used only when IndexedDB is empty). */
  sets: StrengthBundleSet[];
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
  // Own sets of this workout: the client re-seeds from them only when its IndexedDB session is gone.
  const ownSets =
    w.status === "in_progress"
      ? await db
          .select()
          .from(strengthSets)
          .where(and(eq(strengthSets.workoutId, w.id), eq(strengthSets.userId, userId)))
          .orderBy(strengthSets.completedAt)
      : [];
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
    startedAt: w.startAt ? w.startAt.toISOString() : null,
    exercises,
    sets: ownSets
      .filter((s) => s.reps != null && s.weightKg != null)
      .map((s) => ({
        id: s.id,
        workoutExerciseId: s.workoutExerciseId,
        setIndex: s.setIndex,
        reps: s.reps as number,
        weightKg: s.weightKg as number,
        quality: s.quality,
        rpe: s.rpe,
        isWarmup: s.isWarmup,
        completedAt: s.completedAt.toISOString(),
        clientUpdatedAt: s.clientUpdatedAt.toISOString(),
      })),
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

const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD attendu");
const IsoInstant = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "date-heure invalide");
const Rpe = z.number().min(1).max(10);
const SetQualityValue = z.enum(["easy", "perfect", "hard", "failed"]);

const DEFAULT_PRESCRIPTION: StrengthPrescription = {
  sets: 3,
  repMin: 8,
  repMax: 12,
  targetRpeMin: 7,
  targetRpeMax: 8.5,
  intent: "hypertrophy",
  loadSuggestionKg: null,
  restSec: null,
};

const SetPayload = z.object({
  id: z.string().uuid(),
  workoutExerciseId: z.string().uuid(),
  exerciseId: z.string().nullable().optional(),
  setIndex: z.number().int().min(0),
  reps: z.number().int().min(0).max(500),
  weightKg: z.number().min(0).max(1000),
  quality: SetQualityValue.nullable().optional(),
  rpe: Rpe.nullable().optional(),
  isWarmup: z.boolean().optional(),
  completedAt: IsoInstant,
  clientUpdatedAt: IsoInstant,
  e1rmKg: z.number().nullable().optional(),
});

/** Payload of each outbox event type: validated **before** the transaction so a bad event is dropped, not a 500. */
const SessionStartedPayload = z.object({
  date: IsoDay.optional(),
  title: z.string().max(120).optional(),
  templateId: z.string().uuid().nullable().optional().catch(null),
  startedAt: IsoInstant.optional(),
  exercises: z
    .array(
      z.object({
        id: z.string().uuid(),
        exerciseId: z.string().min(1).max(80),
        order: z.number().int().min(0).max(99),
        prescription: z.unknown().optional(),
      }),
    )
    .max(30)
    .optional(),
});
const SetCompletedPayload = z.object({ set: SetPayload });
const SetUpdatedPayload = z.object({
  setId: z.string().uuid(),
  reps: z.number().int().min(0).max(500).optional(),
  weightKg: z.number().min(0).max(1000).optional(),
  rpe: Rpe.nullable().optional(),
  quality: SetQualityValue.nullable().optional(),
  clientUpdatedAt: IsoInstant.optional(),
});
const SetDeletedPayload = z.object({ setId: z.string().uuid() });
const ExerciseAddedPayload = z.object({
  id: z.string().uuid(),
  exerciseId: z.string().min(1).max(80),
  order: z.number().int().min(0).max(99).optional(),
  prescription: z.unknown().optional(),
});
const ExerciseSwappedPayload = z.object({
  workoutExerciseId: z.string().uuid(),
  exerciseId: z.string().min(1).max(80),
});
const SessionFinishedPayload = z.object({
  finishedAt: IsoInstant.optional(),
  rpe: Rpe.nullable().optional(),
  feeling: z.enum(FEELING_VALUES).nullable().optional(),
  painReported: z.boolean().optional(),
  notes: z.string().max(2000).optional(),
  /**
   * Wall-clock minutes between the start and the "Terminer" tap. Never a reason to reject the
   * finish: a session resumed days later sends thousands of minutes, and the declared RPE / pain
   * report it carries must still land. `effectiveStrengthDurationMin` decides what is plausible.
   */
  durationMin: z.number().optional().catch(undefined),
});

const EventEnvelope = {
  id: z.string().uuid(),
  workoutId: z.string().uuid(),
  seq: z.number().int().min(0),
  at: IsoInstant,
};

/** Envelope only (what the route accepts per element); the payload is checked per type by `StrengthEventSchema`. */
export const OutboxEventSchema = z.object({
  ...EventEnvelope,
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
});
export type OutboxEventInput = z.infer<typeof OutboxEventSchema>;

export const StrengthEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...EventEnvelope,
    type: z.literal("session_started"),
    payload: SessionStartedPayload,
  }),
  z.object({ ...EventEnvelope, type: z.literal("set_completed"), payload: SetCompletedPayload }),
  z.object({ ...EventEnvelope, type: z.literal("set_updated"), payload: SetUpdatedPayload }),
  z.object({ ...EventEnvelope, type: z.literal("set_deleted"), payload: SetDeletedPayload }),
  z.object({ ...EventEnvelope, type: z.literal("exercise_added"), payload: ExerciseAddedPayload }),
  z.object({
    ...EventEnvelope,
    type: z.literal("exercise_swapped"),
    payload: ExerciseSwappedPayload,
  }),
  z.object({
    ...EventEnvelope,
    type: z.literal("session_finished"),
    payload: SessionFinishedPayload,
  }),
]);
export type StrengthEvent = z.infer<typeof StrengthEventSchema>;

const CLOSED_STATUSES: ReadonlySet<WorkoutStatus> = new Set(["done", "skipped"]);

/** Longest plausible strength session: anything beyond is a finish tapped long after the last set. */
const MAX_STRENGTH_SESSION_MIN = 240;

/**
 * Effective duration of a strength session (1..240 min), shared by the outbox finish and the daily
 * stale-session sweep so both closing paths agree:
 *  1. the athlete's own start → "Terminer" wall-clock when plausible (declared, measured on the phone);
 *  2. else start → last logged set (a finish tapped hours or days later, a resumed session);
 *  3. else the planned duration (45 min default) — never a multi-day wall-clock fed to the load.
 */
export function effectiveStrengthDurationMin(input: {
  declaredMin: number | null | undefined;
  startAt: Date | null;
  lastSetAt: Date | null;
  plannedDurationMin: number | null;
}): number {
  const plausible = (n: number | null | undefined): n is number =>
    typeof n === "number" && Number.isFinite(n) && n >= 1 && n <= MAX_STRENGTH_SESSION_MIN;
  if (plausible(input.declaredMin)) return Math.round(input.declaredMin);
  if (input.startAt && input.lastSetAt) {
    const measured = Math.round((input.lastSetAt.getTime() - input.startAt.getTime()) / 60_000);
    if (plausible(measured)) return measured;
  }
  return input.plannedDurationMin ?? 45;
}

/**
 * A `done` row closed by the daily sweep carries no declared outcome (rpe and feeling null): the
 * athlete's own late `session_finished` must still apply to it (analysis, load, PRs recomputed
 * with every set now synced). A `skipped` row or a declared outcome is never overwritten.
 */
function acceptsLateFinish(w: typeof workouts.$inferSelect): boolean {
  return w.status === "done" && w.rpe == null && w.feeling == null;
}

/**
 * Apply a batch of client events in the order received (the client appends per workout in `seq`
 * order; re-sorting the whole batch would interleave a re-seeded session with the original one),
 * idempotently (client_events unique id), scoped to the user's own workout. Returns acknowledged
 * event ids (including already-applied, dropped-as-orphan and dropped-as-invalid ones, so a poison
 * event can never block the outbox).
 *
 * Invariants (ARCHITECTURE §4.2): the client is authoritative only while the workout is
 * `in_progress`; a `done`/`skipped` workout is never revived by `session_started` nor overwritten
 * by a stray second `session_finished` once it carries a declared outcome.
 */
export async function applyStrengthEvents(
  db: Db,
  userId: string,
  events: OutboxEventInput[],
): Promise<{ acknowledged: string[]; finishedWorkoutIds: string[] }> {
  const acknowledged: string[] = [];
  const finished: string[] = [];
  for (const raw of events) {
    const [already] = await db
      .select({ id: clientEvents.id })
      .from(clientEvents)
      .where(and(eq(clientEvents.id, raw.id), eq(clientEvents.userId, userId)))
      .limit(1);
    if (already) {
      acknowledged.push(raw.id);
      continue;
    }
    const parsed = StrengthEventSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn("sync.strength.invalid_payload", {
        userId,
        workoutId: raw.workoutId,
        kind: raw.type,
        count: parsed.error.issues.length,
      });
      acknowledged.push(raw.id); // dropped: never let one malformed event block the outbox
      continue;
    }
    const ev = parsed.data;
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
    if (
      w &&
      CLOSED_STATUSES.has(w.status) &&
      ev.type === "session_finished" &&
      !acceptsLateFinish(w)
    ) {
      // A stray second finish (re-seeded shell, replayed batch) must never overwrite the declared outcome.
      log.warn("sync.strength.finish_on_closed_workout", {
        userId,
        workoutId: w.id,
        kind: ev.type,
        status: w.status,
      });
      acknowledged.push(ev.id);
      continue;
    }
    await db.transaction(async (tx) => {
      switch (ev.type) {
        case "session_started": {
          const p = ev.payload;
          if (!w) {
            const inserted = await tx
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
              .onConflictDoNothing()
              .returning({ id: workouts.id });
            if (inserted.length === 0) {
              // The id already exists under another user: write nothing (no exercises, no event row).
              log.warn("sync.strength.unknown_workout", {
                userId,
                workoutId: ev.workoutId,
                kind: ev.type,
              });
              return;
            }
            for (const ex of p.exercises ?? []) {
              if (!getExercise(ex.exerciseId)) continue;
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
                  prescription: pr.success ? pr.data : DEFAULT_PRESCRIPTION,
                  source: "USER",
                })
                .onConflictDoNothing();
            }
          } else if (CLOSED_STATUSES.has(w.status)) {
            // Never revive a finished/skipped workout (its load would vanish from the engine history).
            log.warn("sync.strength.start_on_closed_workout", {
              userId,
              workoutId: w.id,
              kind: ev.type,
              status: w.status,
            });
          } else {
            await tx
              .update(workouts)
              .set({ status: "in_progress", startAt: w.startAt ?? new Date(p.startedAt ?? ev.at) })
              .where(and(eq(workouts.id, w.id), eq(workouts.userId, userId)));
          }
          break;
        }
        case "set_completed": {
          if (!w) break;
          const s = ev.payload.set;
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
              // A client-supplied id colliding with another user's (or another workout's) row updates nothing.
              setWhere: and(eq(strengthSets.userId, userId), eq(strengthSets.workoutId, w.id)),
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
          if (!w) break;
          const p = ev.payload;
          const [existing] = await tx
            .select()
            .from(strengthSets)
            .where(
              and(
                eq(strengthSets.id, p.setId),
                eq(strengthSets.userId, userId),
                eq(strengthSets.workoutId, w.id),
              ),
            )
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
            .where(and(eq(strengthSets.id, existing.id), eq(strengthSets.userId, userId)));
          break;
        }
        case "set_deleted": {
          if (!w) break;
          await tx
            .delete(strengthSets)
            .where(
              and(
                eq(strengthSets.id, ev.payload.setId),
                eq(strengthSets.userId, userId),
                eq(strengthSets.workoutId, w.id),
              ),
            );
          break;
        }
        case "exercise_swapped": {
          if (!w) break;
          const p = ev.payload;
          if (getExercise(p.exerciseId))
            await tx
              .update(workoutExercises)
              .set({ exerciseId: p.exerciseId })
              .where(
                and(
                  eq(workoutExercises.id, p.workoutExerciseId),
                  eq(workoutExercises.userId, userId),
                  eq(workoutExercises.workoutId, w.id),
                ),
              );
          break;
        }
        case "exercise_added": {
          if (!w) break;
          const p = ev.payload;
          if (!getExercise(p.exerciseId)) break;
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
              prescription: pr.success ? pr.data : DEFAULT_PRESCRIPTION,
              source: "USER",
            })
            .onConflictDoNothing();
          break;
        }
        case "session_finished": {
          if (!w) break;
          const p = ev.payload;
          const finishedAt = p.finishedAt ? new Date(p.finishedAt) : new Date(ev.at);
          const [lastSet] = await tx
            .select({ completedAt: strengthSets.completedAt })
            .from(strengthSets)
            .where(and(eq(strengthSets.workoutId, w.id), eq(strengthSets.userId, userId)))
            .orderBy(desc(strengthSets.completedAt))
            .limit(1);
          const declaredMin =
            p.durationMin ??
            (w.startAt ? Math.round((finishedAt.getTime() - w.startAt.getTime()) / 60_000) : null);
          const durationMin = effectiveStrengthDurationMin({
            declaredMin,
            startAt: w.startAt,
            lastSetAt: lastSet?.completedAt ?? null,
            plannedDurationMin: w.plannedDurationMin,
          });
          await finishStrengthWorkout(tx as unknown as Db, userId, {
            workout: w,
            finishedAt,
            durationMin,
            rpe: p.rpe ?? null,
            feeling: p.feeling ?? null,
            painReported: p.painReported ?? false,
            notes: p.notes ?? "",
          });
          // Done or reverted to planned: either way the engine's planned/history set changed.
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

function maxBand(a: IntensityBand, b: IntensityBand): IntensityBand {
  return INTENSITY_BAND_VALUES.indexOf(a) >= INTENSITY_BAND_VALUES.indexOf(b) ? a : b;
}

/**
 * Finish a strength workout server-side (outbox `session_finished`, or the daily stale-session
 * sweep): session-RPE load, actual analysis from the performed sets, e1RM PRs.
 *
 * A session with no working set and no declared RPE was never performed (started by mistake,
 * abandoned from the conflict chooser, swept by the daily job): the row goes back to `planned`
 * instead of becoming a `done` workout with an invented 30 % load — and can be started again.
 */
export async function finishStrengthWorkout(
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
): Promise<{ outcome: "done" | "reverted" }> {
  const w = opts.workout;
  const sets = await db
    .select()
    .from(strengthSets)
    .where(and(eq(strengthSets.workoutId, w.id), eq(strengthSets.userId, userId)));
  const doneSets = sets.filter((s) => !s.isWarmup).length;
  if (doneSets === 0 && opts.rpe == null) {
    await db
      .update(workouts)
      .set({
        status: "planned",
        startAt: null,
        finishedAt: null,
        actualDurationMin: null,
        rpe: null,
        feeling: null,
        painReported: false,
        notes: opts.notes,
        sessionRpeLoad: null,
        realisedIntensity: null,
      })
      .where(and(eq(workouts.id, w.id), eq(workouts.userId, userId)));
    await db
      .delete(workoutAnalyses)
      .where(
        and(
          eq(workoutAnalyses.workoutId, w.id),
          eq(workoutAnalyses.userId, userId),
          eq(workoutAnalyses.phase, "actual"),
        ),
      );
    log.info("strength.finish_reverted_to_planned", { userId, workoutId: w.id });
    return { outcome: "reverted" };
  }

  const [planned] = await db
    .select()
    .from(workoutAnalyses)
    .where(and(eq(workoutAnalyses.workoutId, w.id), eq(workoutAnalyses.phase, "planned")))
    .limit(1);
  // Heavy: a working set at RPE ≥ 8 / hard / failed, or a declared session RPE ≥ 8 (unrated sets).
  const heavy =
    isHeavyStrengthSession(
      sets.map((s) => ({ rpe: s.rpe, quality: s.quality, isWarmup: s.isWarmup })),
    ) ||
    (opts.rpe != null && opts.rpe >= 8);
  // Realised band (ADR-023): upgraded from the declared RPE through the versioned classifier,
  // never below the planned band; heavy sets are at least "moderate" on the metabolic axis.
  const plannedBand = w.plannedIntensity ?? planned?.intensity ?? null;
  const setBand: IntensityBand = heavy ? "moderate" : "easy";
  const realisedIntensity = maxBand(
    realisedBandFromFeedback(plannedBand, {
      loadVector: planned?.loadVector ?? null,
      rpe: opts.rpe,
      heavyStrength: heavy,
    }) ?? setBand,
    setBand,
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
      realisedIntensity,
      intensitySource: "CALCULATED",
    })
    .where(and(eq(workouts.id, w.id), eq(workouts.userId, userId)));

  // Actual analysis: planned profile scaled by performed volume (sets done / sets planned) and RPE.
  const exRows = await db
    .select()
    .from(workoutExercises)
    .where(and(eq(workoutExercises.workoutId, w.id), eq(workoutExercises.userId, userId)));
  const plannedSets =
    exRows.reduce(
      (a, e) => a + (StrengthPrescriptionSchema.safeParse(e.prescription).data?.sets ?? 3),
      0,
    ) || 1;
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
      intensity: realisedIntensity,
      heavyStrength: heavy,
      source: "CALCULATED",
      inputRef: base?.inputRef ?? null,
      algorithmVersion: "strength_actual_v1",
      confidence: toConfidence(opts.rpe != null ? 0.9 : 0.6),
    })
    .onConflictDoUpdate({
      target: [workoutAnalyses.workoutId, workoutAnalyses.phase],
      // A late finish on a system-closed row recomputes everything with the sets now present.
      set: {
        stimulusCredits: credits,
        loadVector: loadVector as (typeof workoutAnalyses.$inferInsert)["loadVector"],
        intensity: realisedIntensity,
        heavyStrength: heavy,
        confidence: toConfidence(opts.rpe != null ? 0.9 : 0.6),
        computedAt: new Date(),
      },
    });

  // e1RM PR detection (estimated, version-pinned): compare the best set e1RM to the best known
  // before this workout — measured sets of other workouts AND the declared 1RM/e1RM records
  // (onboarding "niveau / PR"), so a first session below the declared level is not celebrated (§58, §70).
  const byExercise = new Map<string, typeof sets>();
  for (const s of sets)
    if (!s.isWarmup && s.e1rmKg != null)
      byExercise.set(s.exerciseId, [...(byExercise.get(s.exerciseId) ?? []), s]);
  const declared = await declaredE1rms(db, userId, [...byExercise.keys()]);
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
    const measuredPrev = prev?.best != null ? Number(prev.best) : null;
    const declaredPrev = declared[exerciseId] ?? null;
    const previous =
      measuredPrev === null && declaredPrev === null
        ? null
        : Math.max(measuredPrev ?? -Infinity, declaredPrev ?? -Infinity);
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
        .onConflictDoUpdate({
          target: [
            personalRecords.userId,
            personalRecords.kind,
            personalRecords.exerciseId,
            personalRecords.benchmarkId,
            personalRecords.distanceKey,
            personalRecords.workoutId,
            personalRecords.activityId,
            personalRecords.algorithmVersion,
          ],
          // A late finish on a system-closed row re-runs with the sets synced since: the PR of
          // this workout can only rise (best of all its sets, same baseline).
          set: {
            value: best.e1rmKg,
            reps: best.reps,
            achievedAt: best.completedAt,
            previousValue: previous,
          },
        });
      log.info("pr.detected", { userId, workoutId: w.id, kind: "e1rm" });
    }
  }
  return { outcome: "done" };
}
