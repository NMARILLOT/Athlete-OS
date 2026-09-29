"use client";

import { create } from "zustand";
import { persist, type StateStorage, createJSONStorage } from "zustand/middleware";
import { get as idbGet, set as idbSet, del as idbDel } from "idb-keyval";
import {
  QUALITY_TO_RPE,
  adjustRestForQuality,
  decideProgression,
  estimateOneRepMax,
  restSecondsFor,
  type ProgressionDecision,
  type SetQuality,
  type StrengthPrescription,
} from "@/domain/strength";
import { newId } from "@/lib/ids";

export const STRENGTH_SESSION_STORAGE_KEY = "athleteos.strength-session.v1";

/**
 * Active strength session store (ARCHITECTURE §4 "Strength session (offline-first)").
 *  - Client is authoritative while the session is in progress; the server is a write-behind replica.
 *  - Every mutation appends an event to the outbox; `flushOutbox` posts batches to /api/sync/strength.
 *  - Autoload, rest policy and e1RM are computed client-side from the domain layer (works offline).
 *  - Persisted to IndexedDB with skipHydration; call `rehydrate()` from the session shell.
 */

export interface SessionExercise {
  id: string; // workout_exercises.id (client-generated for ad-hoc sessions)
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

export interface SessionSet {
  id: string;
  exerciseId: string; // session exercise id
  setIndex: number;
  reps: number;
  weightKg: number;
  quality: SetQuality | null;
  rpe: number | null;
  isWarmup: boolean;
  completedAt: string;
  clientUpdatedAt: string;
}

export type OutboxEventType =
  | "session_started"
  | "set_completed"
  | "set_updated"
  | "set_deleted"
  | "exercise_added"
  | "exercise_swapped"
  | "session_finished";

export interface OutboxEvent {
  id: string;
  workoutId: string;
  seq: number;
  type: OutboxEventType;
  payload: Record<string, unknown>;
  at: string;
}

/** A set of this workout already on the server replica (resume when IndexedDB is empty). */
export interface BundleSet {
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
  date: string;
  templateId: string | null;
  /** Server status of the workout: the shell never re-seeds a `done`/`skipped` one. */
  status: "planned" | "in_progress" | "done" | "skipped" | "auto_adjusted";
  /** Server-side start (`workouts.start_at`) when the session is already in progress. */
  startedAt: string | null;
  exercises: SessionExercise[];
  /** Sets already synced for this workout (only meaningful when `status === "in_progress"`). */
  sets: BundleSet[];
  restPolicyOverrides?: Partial<Record<StrengthPrescription["intent"], number>>;
}

interface Session {
  workoutId: string;
  title: string;
  date: string;
  templateId: string | null;
  startedAt: string;
  finishedAt: string | null;
  exercises: SessionExercise[];
  sets: SessionSet[];
  currentExerciseIndex: number;
  /** Working weight per session exercise id (client-side autoload). */
  workingWeightKg: Record<string, number | null>;
  restEndsAt: number | null;
  restTotalSec: number;
  seq: number;
  finish: {
    rpe: number | null;
    feeling: "great" | "good" | "meh" | "too_hard" | null;
    painReported: boolean;
    notes: string;
  } | null;
}

interface StrengthState {
  hydrated: boolean;
  session: Session | null;
  outbox: OutboxEvent[];
  /**
   * The athlete this snapshot belongs to (ARCHITECTURE §4.6): a session/outbox persisted under one
   * account is never posted, displayed or resumed under another one on the same device.
   */
  ownerUserId: string | null;
  flushing: boolean;
  lastFlushError: string | null;
  // lifecycle
  /** Fresh session from a planned bundle: seeds working weights and emits `session_started`. */
  startSession: (bundle: StrengthBundle) => void;
  /**
   * Resume a session the server already knows as `in_progress` when IndexedDB is empty
   * (ARCHITECTURE §4.2: replica only when the local store is gone): seeds the logged sets from the
   * bundle and emits nothing — the server is already in the right state.
   */
  resumeSession: (bundle: StrengthBundle) => void;
  resumeOrNull: () => Session | null;
  clearSession: () => void;
  // in-session
  setCurrentExercise: (index: number) => void;
  adjustWeight: (exerciseId: string, deltaKg: number) => void;
  setWeight: (exerciseId: string, kg: number) => void;
  completeSet: (
    exerciseId: string,
    reps: number,
    weightKg: number,
    isWarmup?: boolean,
  ) => SessionSet;
  rateLastSet: (setId: string, quality: SetQuality) => void;
  updateSet: (
    setId: string,
    patch: Partial<Pick<SessionSet, "reps" | "weightKg" | "rpe" | "quality">>,
  ) => void;
  deleteSet: (setId: string) => void;
  swapExercise: (
    exerciseId: string,
    newExerciseId: string,
    newName: string,
    incrementKg: number,
  ) => void;
  skipRest: () => void;
  extendRest: (sec: number) => void;
  finishSession: (finish: NonNullable<Session["finish"]>) => void;
  // sync
  flushOutbox: () => Promise<void>;
  ackEvents: (ids: string[]) => void;
}

const idbStorage: StateStorage = {
  getItem: async (name) => (await idbGet<string>(name)) ?? null,
  setItem: async (name, value) => {
    await idbSet(name, value);
  },
  removeItem: async (name) => {
    await idbDel(name);
  },
};

function nowIso(): string {
  return new Date().toISOString();
}

/** The batch currently being posted, so concurrent flush calls chain instead of racing. */
let inflight: Promise<void> | null = null;

/** The signed-in athlete, published by the (app) layout (`SessionOwner`); null outside the app. */
let currentOwner: string | null = null;

/** A persisted snapshot owned by another account than the current one (or by an unknown one). */
function isForeignSnapshot(ownerUserId: string | null): boolean {
  return ownerUserId != null && ownerUserId !== currentOwner;
}

/** Next `seq` for a (re-)seeded session: continue after the events still queued for this workout. */
function queuedSeq(outbox: OutboxEvent[], workoutId: string): number {
  return outbox.reduce((m, e) => (e.workoutId === workoutId && e.seq > m ? e.seq : m), 0);
}

/** Full deterministic autoload decision (rule id + spec-worded rationale, spec §79). */
export function suggestDecision(ex: SessionExercise): ProgressionDecision {
  return decideProgression({
    prescription: ex.prescription,
    incrementKg: ex.incrementKg,
    history: ex.lastExposure ? [{ date: ex.lastExposure.date, sets: ex.lastExposure.sets }] : [],
    knownE1rmKg: ex.bestE1rmKg,
  });
}

/** Deterministic next-weight suggestion from history + prescription (client-side autoload, spec §79). */
export function suggestWeight(ex: SessionExercise): number | null {
  return suggestDecision(ex).nextWeightKg ?? ex.prescription.loadSuggestionKg ?? null;
}

/** ARCHITECTURE §7: ask for durable storage so the offline session/outbox cannot be evicted. */
export function requestPersistentStorage(): void {
  try {
    if (typeof navigator === "undefined") return;
    void navigator.storage?.persist?.().catch(() => undefined);
  } catch {
    /* not supported */
  }
}

export const useStrengthSession = create<StrengthState>()(
  persist(
    (set, get) => {
      const push = (type: OutboxEventType, payload: Record<string, unknown>) => {
        const s = get().session;
        if (!s) return;
        const seq = s.seq + 1;
        const ev: OutboxEvent = {
          id: newId(),
          workoutId: s.workoutId,
          seq,
          type,
          payload,
          at: nowIso(),
        };
        set((st) => ({
          outbox: [...st.outbox, ev],
          session: st.session ? { ...st.session, seq } : st.session,
        }));
      };
      return {
        hydrated: false,
        session: null,
        outbox: [],
        ownerUserId: null,
        flushing: false,
        lastFlushError: null,

        startSession: (bundle) => {
          requestPersistentStorage();
          const working: Record<string, number | null> = {};
          for (const ex of bundle.exercises) working[ex.id] = suggestWeight(ex);
          const st = get();
          const session: Session = {
            workoutId: bundle.workoutId,
            title: bundle.title,
            date: bundle.date,
            templateId: bundle.templateId,
            startedAt: nowIso(),
            finishedAt: null,
            exercises: [...bundle.exercises].sort((a, b) => a.order - b.order),
            sets: [],
            currentExerciseIndex: 0,
            workingWeightKg: working,
            restEndsAt: null,
            restTotalSec: 0,
            seq: queuedSeq(st.outbox, bundle.workoutId),
            finish: null,
          };
          set({ session, ownerUserId: currentOwner ?? st.ownerUserId });
          push("session_started", {
            workoutId: bundle.workoutId,
            templateId: bundle.templateId,
            date: bundle.date,
            title: bundle.title,
            startedAt: session.startedAt,
            exercises: bundle.exercises.map((e) => ({
              id: e.id,
              exerciseId: e.exerciseId,
              order: e.order,
              prescription: e.prescription,
            })),
          });
        },

        resumeSession: (bundle) => {
          requestPersistentStorage();
          const exercises = [...bundle.exercises].sort((a, b) => a.order - b.order);
          const known = new Set(exercises.map((e) => e.id));
          const sets: SessionSet[] = bundle.sets
            .filter((x) => known.has(x.workoutExerciseId))
            .map((x) => ({
              id: x.id,
              exerciseId: x.workoutExerciseId,
              setIndex: x.setIndex,
              reps: x.reps,
              weightKg: x.weightKg,
              quality: x.quality,
              rpe: x.rpe,
              isWarmup: x.isWarmup,
              completedAt: x.completedAt,
              clientUpdatedAt: x.clientUpdatedAt,
            }));
          const working: Record<string, number | null> = {};
          let currentExerciseIndex = exercises.length ? exercises.length - 1 : 0;
          for (const [i, ex] of exercises.entries()) {
            const own = sets.filter((x) => x.exerciseId === ex.id && !x.isWarmup);
            working[ex.id] = own.length
              ? (own[own.length - 1]?.weightKg ?? null)
              : suggestWeight(ex);
            if (own.length < ex.prescription.sets && i < currentExerciseIndex)
              currentExerciseIndex = i;
          }
          const st = get();
          const session: Session = {
            workoutId: bundle.workoutId,
            title: bundle.title,
            date: bundle.date,
            templateId: bundle.templateId,
            startedAt: bundle.startedAt ?? nowIso(),
            finishedAt: null,
            exercises,
            sets,
            currentExerciseIndex,
            workingWeightKg: working,
            restEndsAt: null,
            restTotalSec: 0,
            seq: queuedSeq(st.outbox, bundle.workoutId),
            finish: null,
          };
          set({ session, ownerUserId: currentOwner ?? st.ownerUserId });
        },

        resumeOrNull: () => get().session,

        clearSession: () => set({ session: null }),

        setCurrentExercise: (index) =>
          set((st) =>
            st.session
              ? {
                  session: {
                    ...st.session,
                    currentExerciseIndex: Math.max(
                      0,
                      Math.min(index, st.session.exercises.length - 1),
                    ),
                  },
                }
              : {},
          ),

        adjustWeight: (exerciseId, deltaKg) =>
          set((st) => {
            if (!st.session) return {};
            const cur = st.session.workingWeightKg[exerciseId] ?? 0;
            const next = Math.max(0, Math.round((cur + deltaKg) * 2) / 2);
            return {
              session: {
                ...st.session,
                workingWeightKg: { ...st.session.workingWeightKg, [exerciseId]: next },
              },
            };
          }),

        setWeight: (exerciseId, kg) =>
          set((st) =>
            st.session
              ? {
                  session: {
                    ...st.session,
                    workingWeightKg: {
                      ...st.session.workingWeightKg,
                      [exerciseId]: Math.max(0, kg),
                    },
                  },
                }
              : {},
          ),

        completeSet: (exerciseId, reps, weightKg, isWarmup = false) => {
          const st = get();
          const s = st.session;
          if (!s) throw new Error("no active session");
          const ex = s.exercises.find((e) => e.id === exerciseId);
          const existing = s.sets.filter((x) => x.exerciseId === exerciseId && !x.isWarmup).length;
          const setIndex = isWarmup ? 0 : existing + 1;
          const record: SessionSet = {
            id: newId(),
            exerciseId,
            setIndex,
            reps,
            weightKg,
            quality: null,
            rpe: null,
            isWarmup,
            completedAt: nowIso(),
            clientUpdatedAt: nowIso(),
          };
          const intent = ex?.prescription.intent ?? "strength";
          const restSec = restSecondsFor(intent, ex?.prescription.restSec ?? null);
          set({
            session: {
              ...s,
              sets: [...s.sets, record],
              restEndsAt: isWarmup ? null : Date.now() + restSec * 1000,
              restTotalSec: isWarmup ? 0 : restSec,
            },
          });
          push("set_completed", {
            set: {
              ...record,
              exerciseId: ex?.exerciseId ?? null,
              workoutExerciseId: exerciseId,
              e1rmKg: !isWarmup ? estimateOneRepMax(weightKg, reps) : null,
            },
          });
          return record;
        },

        rateLastSet: (setId, quality) => {
          const st = get();
          const s = st.session;
          if (!s) return;
          const target = s.sets.find((x) => x.id === setId);
          if (!target) return;
          const ex = s.exercises.find((e) => e.id === target.exerciseId);
          const intent = ex?.prescription.intent ?? "strength";
          const base = s.restTotalSec || restSecondsFor(intent, ex?.prescription.restSec ?? null);
          const adjusted = adjustRestForQuality(base, intent, quality);
          const elapsed = s.restEndsAt ? s.restEndsAt - Date.now() : 0;
          const restEndsAt = s.restEndsAt ? s.restEndsAt + (adjusted - base) * 1000 : null;
          void elapsed;
          const rpe = QUALITY_TO_RPE[quality];
          const sets = s.sets.map((x) =>
            x.id === setId ? { ...x, quality, rpe, clientUpdatedAt: nowIso() } : x,
          );
          set({ session: { ...s, sets, restEndsAt, restTotalSec: adjusted } });
          push("set_updated", { setId, quality, rpe, clientUpdatedAt: nowIso() });
        },

        updateSet: (setId, patch) => {
          const s = get().session;
          if (!s) return;
          const sets = s.sets.map((x) =>
            x.id === setId ? { ...x, ...patch, clientUpdatedAt: nowIso() } : x,
          );
          set({ session: { ...s, sets } });
          push("set_updated", { setId, ...patch, clientUpdatedAt: nowIso() });
        },

        deleteSet: (setId) => {
          const s = get().session;
          if (!s) return;
          const remaining = s.sets.filter((x) => x.id !== setId);
          // Renumber display indices per exercise (set_index is display order only).
          const counters: Record<string, number> = {};
          const renumbered = remaining.map((x) => {
            if (x.isWarmup) return x;
            counters[x.exerciseId] = (counters[x.exerciseId] ?? 0) + 1;
            return { ...x, setIndex: counters[x.exerciseId] as number };
          });
          set({ session: { ...s, sets: renumbered } });
          push("set_deleted", { setId });
        },

        swapExercise: (exerciseId, newExerciseId, newName, incrementKg) => {
          const s = get().session;
          if (!s) return;
          const exercises = s.exercises.map((e) =>
            e.id === exerciseId
              ? {
                  ...e,
                  exerciseId: newExerciseId,
                  name: newName,
                  incrementKg,
                  lastExposure: null,
                  bestE1rmKg: null,
                }
              : e,
          );
          set({
            session: {
              ...s,
              exercises,
              workingWeightKg: { ...s.workingWeightKg, [exerciseId]: null },
            },
          });
          push("exercise_swapped", { workoutExerciseId: exerciseId, exerciseId: newExerciseId });
        },

        skipRest: () =>
          set((st) => (st.session ? { session: { ...st.session, restEndsAt: null } } : {})),

        extendRest: (sec) =>
          set((st) =>
            st.session && st.session.restEndsAt
              ? {
                  session: {
                    ...st.session,
                    restEndsAt: st.session.restEndsAt + sec * 1000,
                    restTotalSec: st.session.restTotalSec + sec,
                  },
                }
              : {},
          ),

        finishSession: (finish) => {
          const s = get().session;
          if (!s) return;
          const finishedAt = nowIso();
          set({ session: { ...s, finishedAt, finish, restEndsAt: null } });
          push("session_finished", {
            finishedAt,
            ...finish,
            durationMin: Math.max(
              1,
              Math.round((Date.parse(finishedAt) - Date.parse(s.startedAt)) / 60000),
            ),
          });
        },

        /**
         * Post the outbox in batches. Resolves once every queued event has been *attempted*: a call
         * made while a batch is in flight waits for it and then flushes what is left (so "Terminer"
         * or sign-out can rely on `outbox.length` afterwards). Stops on error, offline, 401, or when
         * a batch makes no progress.
         */
        flushOutbox: async () => {
          if (inflight) {
            await inflight;
            if (get().outbox.length > 0 && !get().lastFlushError) await get().flushOutbox();
            return;
          }
          const st = get();
          if (st.outbox.length === 0) return;
          // Another account's (or an unknown owner's) queue is never posted under this cookie.
          if (isForeignSnapshot(st.ownerUserId)) return;
          if (typeof navigator !== "undefined" && navigator.onLine === false) {
            set({ lastFlushError: "offline" });
            return;
          }
          const before = st.outbox.length;
          inflight = (async () => {
            set({ flushing: true, lastFlushError: null });
            try {
              const batch = st.outbox.slice(0, 50);
              const res = await fetch("/api/sync/strength", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ events: batch }),
              });
              if (res.status === 401 || res.status === 403) {
                set({ lastFlushError: "auth" });
                return;
              }
              if (!res.ok) throw new Error(`sync failed: ${res.status}`);
              const data = (await res.json()) as { acknowledged: string[] };
              get().ackEvents(data.acknowledged ?? []);
            } catch (err) {
              set({ lastFlushError: err instanceof Error ? err.message : "sync failed" });
            } finally {
              set({ flushing: false });
            }
          })();
          try {
            await inflight;
          } finally {
            inflight = null;
          }
          const after = get().outbox.length;
          if (after > 0 && after < before && !get().lastFlushError) await get().flushOutbox();
        },

        ackEvents: (ids) => set((st) => ({ outbox: st.outbox.filter((e) => !ids.includes(e.id)) })),
      };
    },
    {
      name: STRENGTH_SESSION_STORAGE_KEY,
      storage: createJSONStorage(() => idbStorage),
      skipHydration: true,
      partialize: (st) =>
        ({
          session: st.session,
          outbox: st.outbox,
          ownerUserId: st.ownerUserId,
        }) as unknown as StrengthState,
    },
  ),
);

let hydration: Promise<void> | null = null;

/**
 * Rehydrate from IndexedDB once per page lifetime (the shell, the global flusher and the sign-out
 * flow all call it; a second rehydrate would overwrite in-memory acks with a stale snapshot).
 */
export function rehydrateStrengthSession(): Promise<void> {
  hydration ??= (async () => {
    await useStrengthSession.persist.rehydrate();
    useStrengthSession.setState({ hydrated: true });
  })();
  return hydration;
}

/** Whether un-acked events for this workout are still queued (e.g. an offline finish). */
export function hasPendingEvents(workoutId: string): boolean {
  return useStrengthSession.getState().outbox.some((e) => e.workoutId === workoutId);
}

/** The athlete currently published as owner of this device's session store (null outside the app). */
export function strengthSessionOwner(): string | null {
  return currentOwner;
}

/**
 * Bind the store to the signed-in athlete (called by the (app) layout's `SessionOwner` and by the
 * strength shell before it resolves its phase; `null` when leaving the app):
 *  - a snapshot without owner (first run, legacy) is adopted by this account;
 *  - a snapshot owned by another account is foreign: it is neither posted nor displayed, and is
 *    dropped when another athlete signs in on the same device (ARCHITECTURE §4.6).
 * Idempotent and safe to await from several places: it shares the single rehydration.
 */
export async function bindStrengthSessionOwner(userId: string | null): Promise<void> {
  currentOwner = userId;
  if (!userId) return;
  await rehydrateStrengthSession();
  if (currentOwner !== userId) return; // superseded meanwhile (navigation, strict-mode remount)
  const st = useStrengthSession.getState();
  if (st.ownerUserId === userId) return;
  if (st.ownerUserId == null) {
    useStrengthSession.setState({ ownerUserId: userId });
    return;
  }
  // Foreign: another athlete signed in on this device — drop it and start clean for this account.
  useStrengthSession.setState({
    session: null,
    outbox: [],
    ownerUserId: userId,
    lastFlushError: null,
  });
}

/**
 * Sign-out / account deletion (ARCHITECTURE §4.6, §7): the persisted session and outbox belong to
 * the signed-in athlete and must not survive into another account on the same device.
 */
export async function clearStrengthSessionStorage(): Promise<void> {
  useStrengthSession.setState({
    session: null,
    outbox: [],
    ownerUserId: null,
    lastFlushError: null,
  });
  try {
    await idbDel(STRENGTH_SESSION_STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
}
