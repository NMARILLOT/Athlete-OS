"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Minus, Plus, SkipForward, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { formatKg } from "@/lib/format";
import {
  rehydrateStrengthSession,
  suggestWeight,
  useStrengthSession,
  type StrengthBundle,
} from "@/stores/strength-session";
import { estimateOneRepMax, type SetQuality } from "@/domain/strength";
import { FinishSheet } from "./finish-sheet";

/**
 * Strength mode (spec §10, §77): one exercise at a time, huge buttons, one-hand use, offline-first.
 * The store is authoritative; the bundle (from the server) only seeds a new session.
 */
export function StrengthSessionShell({
  bundle,
  workoutId,
}: {
  bundle: StrengthBundle | null;
  workoutId: string;
}) {
  const router = useRouter();
  const st = useStrengthSession();
  const [ready, setReady] = useState(false);
  const [finishOpen, setFinishOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await rehydrateStrengthSession();
      if (cancelled) return;
      const s = useStrengthSession.getState();
      if (!s.session || s.session.workoutId !== workoutId || s.session.finishedAt) {
        if (bundle) s.startSession(bundle);
      }
      setReady(true);
      void s.flushOutbox();
    })();
    return () => {
      cancelled = true;
    };
  }, [bundle, workoutId]);

  // Ask the service worker to precache this shell (and its return routes) for cold offline starts.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const ctrl = navigator.serviceWorker.controller;
    if (!ctrl) return;
    ctrl.postMessage({ type: "PRECACHE", urls: [window.location.pathname, "/today", "/offline"] });
  }, [workoutId]);

  // Timer tick + flush on visibility/online (ARCHITECTURE §4).
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    const onVis = () => {
      setNow(Date.now());
      void useStrengthSession.getState().flushOutbox();
    };
    window.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", onVis);
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> };
    };
    nav.wakeLock
      ?.request("screen")
      .then((l) => (lock = l))
      .catch(() => undefined);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("online", onVis);
      void lock?.release();
    };
  }, []);

  const session = st.session;
  const ex = session?.exercises[session.currentExerciseIndex] ?? null;
  const exSets = useMemo(
    () => (session && ex ? session.sets.filter((s) => s.exerciseId === ex.id && !s.isWarmup) : []),
    [session, ex],
  );
  const lastSet = exSets[exSets.length - 1] ?? null;
  const restLeft = session?.restEndsAt
    ? Math.max(0, Math.ceil((session.restEndsAt - now) / 1000))
    : 0;
  const resting = restLeft > 0;
  const weight = ex ? (session?.workingWeightKg[ex.id] ?? suggestWeight(ex) ?? 0) : 0;
  const setNumber = exSets.length + 1;
  const [reps, setReps] = useState<number | null>(null);
  const targetReps = ex ? ex.prescription.repMax : 0;
  const repsToLog = reps ?? targetReps;

  const chime = useCallback(() => {
    try {
      const W = window as unknown as {
        AudioContext?: typeof AudioContext;
        webkitAudioContext?: typeof AudioContext;
      };
      const Ctx = W.AudioContext ?? W.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.frequency.value = 880;
      g.gain.value = 0.05;
      o.start();
      o.stop(ctx.currentTime + 0.15);
    } catch {
      /* audio not available */
    }
  }, []);

  useEffect(() => {
    if (session?.restEndsAt && restLeft === 0 && now - session.restEndsAt < 1500) chime();
  }, [restLeft, session?.restEndsAt, now, chime]);

  if (!ready) return <p className="py-10 text-center text-fg-muted">Chargement de la séance…</p>;
  if (!session || !ex) {
    return (
      <div className="py-6">
        <PageHeader title="Séance" closeHref="/today" />
        <p className="text-fg-muted">Aucune séance active. Retour à Today.</p>
        <Button className="mt-4" onClick={() => router.push("/today")}>
          Today
        </Button>
      </div>
    );
  }

  const done = (isWarmup = false) => {
    const set = st.completeSet(ex.id, repsToLog, weight, isWarmup);
    setReps(null);
    void st.flushOutbox();
    return set;
  };
  const rate = (q: SetQuality) => {
    if (!lastSet) return;
    st.rateLastSet(lastSet.id, q);
    void st.flushOutbox();
  };
  const last = ex.lastExposure?.sets.at(-1) ?? null;
  const allSetsDone = exSets.length >= ex.prescription.sets;
  const isLastExercise = session.currentExerciseIndex >= session.exercises.length - 1;
  const totalSets = session.exercises.reduce((a, e) => a + e.prescription.sets, 0);
  const doneSets = session.sets.filter((s) => !s.isWarmup).length;

  return (
    <div className="flex min-h-dvh flex-col pb-6">
      <PageHeader
        title={session.title}
        closeHref="/today"
        action={
          <span className="text-xs text-fg-muted tabular-nums">
            {doneSets}/{totalSets}
          </span>
        }
      />

      <div className="flex items-center justify-between">
        <button
          type="button"
          aria-label="Exercice précédent"
          onClick={() => st.setCurrentExercise(session.currentExerciseIndex - 1)}
          disabled={session.currentExerciseIndex === 0}
          className="text-fg-muted disabled:opacity-30"
        >
          <ChevronLeft className="size-7" />
        </button>
        <div className="text-center">
          <p className="text-xs tracking-wide text-fg-subtle uppercase">
            Exercice {session.currentExerciseIndex + 1}/{session.exercises.length}
          </p>
          <h2 className="text-2xl font-semibold tracking-tight">{ex.name}</h2>
        </div>
        <button
          type="button"
          aria-label="Exercice suivant"
          onClick={() => st.setCurrentExercise(session.currentExerciseIndex + 1)}
          disabled={isLastExercise}
          className="text-fg-muted disabled:opacity-30"
        >
          <ChevronRight className="size-7" />
        </button>
      </div>

      <div className="mt-6 text-center">
        <p className="text-sm text-fg-muted">
          Set {Math.min(setNumber, ex.prescription.sets)} / {ex.prescription.sets} · cible{" "}
          {ex.prescription.repMin === ex.prescription.repMax
            ? ex.prescription.repMax
            : `${ex.prescription.repMin}–${ex.prescription.repMax}`}{" "}
          reps · RPE {ex.prescription.targetRpeMin}–{ex.prescription.targetRpeMax}
        </p>
        <div className="mt-3 flex items-center justify-center gap-3">
          <button
            type="button"
            aria-label="-1 rep"
            onClick={() => setReps(Math.max(0, repsToLog - 1))}
            className="flex size-12 items-center justify-center rounded-full bg-bg-muted text-xl"
          >
            −
          </button>
          <div className="text-5xl font-semibold tabular-nums">{repsToLog}</div>
          <button
            type="button"
            aria-label="+1 rep"
            onClick={() => setReps(repsToLog + 1)}
            className="flex size-12 items-center justify-center rounded-full bg-bg-muted text-xl"
          >
            +
          </button>
        </div>
        <p className="mt-1 text-xs text-fg-subtle">reps</p>

        <div className="mt-5 flex items-center justify-center gap-3">
          <Button
            variant="secondary"
            size="lg"
            aria-label={`-${ex.incrementKg} kg`}
            onClick={() => st.adjustWeight(ex.id, -ex.incrementKg)}
          >
            <Minus className="size-5" /> {ex.incrementKg}
          </Button>
          <div className="min-w-32 text-4xl font-semibold tabular-nums">{formatKg(weight)}</div>
          <Button
            variant="secondary"
            size="lg"
            aria-label={`+${ex.incrementKg} kg`}
            onClick={() => st.adjustWeight(ex.id, ex.incrementKg)}
          >
            <Plus className="size-5" /> {ex.incrementKg}
          </Button>
        </div>
        <div className="mt-2 flex justify-center gap-4 text-xs text-fg-muted">
          <span>
            Dernière :{" "}
            {last ? `${last.weightKg} × ${last.reps}${last.rpe ? ` @${last.rpe}` : ""}` : "—"}
          </span>
          <span>e1RM ≈ {ex.bestE1rmKg ? `${ex.bestE1rmKg} kg` : "—"}</span>
          {weight > 0 ? (
            <span>cette série ≈ {estimateOneRepMax(weight, repsToLog) ?? "—"} kg</span>
          ) : null}
        </div>
      </div>

      <div className="mt-8 flex flex-col gap-3">
        {resting ? (
          <div className="rounded-2xl border border-border bg-bg-elevated p-4 text-center">
            <p className="flex items-center justify-center gap-2 text-sm text-fg-muted">
              <Timer className="size-4" /> Récup
            </p>
            <p className="text-5xl font-semibold tabular-nums">
              {Math.floor(restLeft / 60)}:{String(restLeft % 60).padStart(2, "0")}
            </p>
            {lastSet && lastSet.quality === null ? (
              <div className="mt-3 grid grid-cols-3 gap-2">
                <Button variant="secondary" onClick={() => rate("easy")}>
                  Facile
                </Button>
                <Button variant="secondary" onClick={() => rate("perfect")}>
                  Parfait
                </Button>
                <Button variant="secondary" onClick={() => rate("hard")}>
                  Dur
                </Button>
              </div>
            ) : null}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button variant="ghost" onClick={() => st.extendRest(30)}>
                +30 s
              </Button>
              <Button variant="ghost" onClick={() => st.skipRest()}>
                <SkipForward className="size-4" /> Passer
              </Button>
            </div>
          </div>
        ) : (
          <Button size="xl" full onClick={() => done(false)}>
            VALIDER
          </Button>
        )}
        {lastSet && lastSet.quality === null && !resting ? (
          <div className="grid grid-cols-4 gap-2">
            <Button variant="secondary" onClick={() => rate("easy")}>
              Facile
            </Button>
            <Button variant="secondary" onClick={() => rate("perfect")}>
              Parfait
            </Button>
            <Button variant="secondary" onClick={() => rate("hard")}>
              Dur
            </Button>
            <Button variant="danger" onClick={() => rate("failed")}>
              Échec
            </Button>
          </div>
        ) : null}
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => done(true)}>
            Série d&apos;échauffement
          </Button>
          {allSetsDone && !isLastExercise ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => st.setCurrentExercise(session.currentExerciseIndex + 1)}
            >
              Exercice suivant →
            </Button>
          ) : null}
        </div>
      </div>

      {exSets.length ? (
        <ul className="mt-6 flex flex-col gap-1">
          {exSets.map((s) => (
            <li key={s.id} className="flex items-center justify-between text-sm text-fg-muted">
              <span>
                Set {s.setIndex} · {s.weightKg} kg × {s.reps} {s.quality ? `· ${s.quality}` : ""}
              </span>
              <button
                type="button"
                className="text-xs text-fg-subtle underline-offset-2 hover:underline"
                onClick={() => st.deleteSet(s.id)}
              >
                supprimer
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-auto pt-8">
        <Button variant="outline" full size="lg" onClick={() => setFinishOpen(true)}>
          Terminer la séance
        </Button>
        {st.outbox.length ? (
          <p className="mt-2 text-center text-[11px] text-fg-subtle">
            {st.outbox.length} événement(s) en attente de synchronisation
            {st.lastFlushError ? " · hors ligne" : ""}
          </p>
        ) : null}
      </div>

      {finishOpen ? (
        <FinishSheet
          onClose={() => setFinishOpen(false)}
          onFinish={async (finish) => {
            st.finishSession(finish);
            await st.flushOutbox();
            const outboxEmpty = useStrengthSession.getState().outbox.length === 0;
            st.clearSession();
            setFinishOpen(false);
            router.push(outboxEmpty ? `/workouts/${workoutId}` : "/today");
          }}
        />
      ) : null}
    </div>
  );
}
