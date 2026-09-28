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
  type SetQuality,
  type StrengthPrescription,
} from "@/domain/strength";
import { newId } from "@/lib/ids";

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

export interface StrengthBundle {
  workoutId: string;
  title: string;
  date: string;
  templateId: string | null;
  exercises: SessionExercise[];
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
  flushing: boolean;
  lastFlushError: string | null;
  // lifecycle
  startSession: (bundle: StrengthBundle) => void;
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

/** Deterministic next-weight suggestion from history + prescription (client-side autoload, spec §79). */
export function suggestWeight(ex: SessionExercise): number | null {
  const decision = decideProgression({
    prescription: ex.prescription,
    incrementKg: ex.incrementKg,
    history: ex.lastExposure ? [{ date: ex.lastExposure.date, sets: ex.lastExposure.sets }] : [],
    knownE1rmKg: ex.bestE1rmKg,
  });
  return decision.nextWeightKg ?? ex.prescription.loadSuggestionKg ?? null;
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
        flushing: false,
        lastFlushError: null,

        startSession: (bundle) => {
          const working: Record<string, number | null> = {};
          for (const ex of bundle.exercises) working[ex.id] = suggestWeight(ex);
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
            seq: 0,
            finish: null,
          };
          set({ session });
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

        flushOutbox: async () => {
          const st = get();
          if (st.flushing || st.outbox.length === 0) return;
          if (typeof navigator !== "undefined" && navigator.onLine === false) return;
          set({ flushing: true, lastFlushError: null });
          try {
            const batch = st.outbox.slice(0, 50);
            const res = await fetch("/api/sync/strength", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ events: batch }),
            });
            if (res.status === 401) {
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
          if (get().outbox.length > 0 && !get().lastFlushError) void get().flushOutbox();
        },

        ackEvents: (ids) => set((st) => ({ outbox: st.outbox.filter((e) => !ids.includes(e.id)) })),
      };
    },
    {
      name: "athleteos.strength-session.v1",
      storage: createJSONStorage(() => idbStorage),
      skipHydration: true,
      partialize: (st) => ({ session: st.session, outbox: st.outbox }) as unknown as StrengthState,
    },
  ),
);

/** Rehydrate from IndexedDB (call once from the session shell); resolves when done. */
export async function rehydrateStrengthSession(): Promise<void> {
  await useStrengthSession.persist.rehydrate();
  useStrengthSession.setState({ hydrated: true });
}
