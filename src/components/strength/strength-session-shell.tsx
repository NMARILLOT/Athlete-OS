"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Minus, Plus, SkipForward, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { formatKg } from "@/lib/format";
import {
  bindStrengthSessionOwner,
  hasPendingEvents,
  suggestDecision,
  useStrengthSession,
  type StrengthBundle,
} from "@/stores/strength-session";
import { estimateOneRepMax, type SetQuality } from "@/domain/strength";
import { FinishSheet } from "./finish-sheet";

/**
 * What the shell shows for this route (ARCHITECTURE §4.2: the client is authoritative only while the
 * workout is in progress).
 *  - active:   a live session for this workout (resumed from IndexedDB, or seeded from the bundle)
 *  - conflict: another unfinished session is live — never silently replace it
 *  - syncing:  this workout was finished locally but its events are still queued (offline / 401)
 *  - closed:   the server says done/skipped (or the local finish is fully acked): link to the workout
 *  - none:     nothing local and no bundle (offline cold start without a cached session)
 */
type Phase = "loading" | "active" | "conflict" | "syncing" | "closed" | "none";

function resolvePhase(bundle: StrengthBundle | null, workoutId: string, userId: string): Phase {
  const st = useStrengthSession.getState();
  // A snapshot of another account is never displayed (bindStrengthSessionOwner already dropped it).
  const live = st.ownerUserId != null && st.ownerUserId !== userId ? null : st.session;
  const serverClosed = bundle?.status === "done" || bundle?.status === "skipped";
  if (serverClosed && live?.workoutId === workoutId && !live.finishedAt) {
    // Closed server-side meanwhile (daily sweep, "Sauter"): the client is authoritative only while
    // in_progress (§4.2). Drop the local session; its queued set events still flush and are kept.
    st.clearSession();
    return "closed";
  }
  if (live && live.workoutId === workoutId) {
    if (!live.finishedAt) return "active";
    if (hasPendingEvents(workoutId)) return "syncing";
    // Finished and every event acknowledged: the server owns the outcome now.
    st.clearSession();
    return "closed";
  }
  if (live && !live.finishedAt) return "conflict";
  // A finished session of another workout: its queued events stay in the global outbox.
  if (live) st.clearSession();
  if (!bundle) return "none";
  if (serverClosed) return "closed";
  if (bundle.status === "in_progress") st.resumeSession(bundle);
  else st.startSession(bundle);
  return "active";
}

/**
 * Strength mode (spec §10, §77): one exercise at a time, huge buttons, one-hand use, offline-first.
 * The store is authoritative; the bundle (from the server) only seeds a new session.
 */
export function StrengthSessionShell({
  bundle,
  workoutId,
  userId,
}: {
  bundle: StrengthBundle | null;
  workoutId: string;
  /** The signed-in athlete: the persisted session is bound to its owner (ARCHITECTURE §4.6). */
  userId: string;
}) {
  const router = useRouter();
  const st = useStrengthSession();
  const [phase, setPhase] = useState<Phase>("loading");
  const [finishOpen, setFinishOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [reps, setReps] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Rehydrates once per page lifetime and drops a snapshot left by another account.
      await bindStrengthSessionOwner(userId);
      if (cancelled) return;
      setPhase(resolvePhase(bundle, workoutId, userId));
      void useStrengthSession.getState().flushOutbox();
    })();
    return () => {
      cancelled = true;
    };
  }, [bundle, workoutId, userId]);

  // Ask the service worker to precache this shell (and its return routes) for cold offline starts.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const ctrl = navigator.serviceWorker.controller;
    if (!ctrl) return;
    ctrl.postMessage({ type: "PRECACHE", urls: [window.location.pathname, "/today", "/offline"] });
  }, [workoutId]);

  // Timer tick + flush on visibility/online (ARCHITECTURE §4) + wake lock.
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

  // One AudioContext for the whole session, unlocked inside tap handlers (iOS only starts audio in a
  // user gesture, ARCHITECTURE §4.3); closed on unmount.
  const audioRef = useRef<AudioContext | null>(null);
  const lastChimedRef = useRef<number | null>(null);
  const unlockAudio = useCallback(() => {
    try {
      const W = window as unknown as {
        AudioContext?: typeof AudioContext;
        webkitAudioContext?: typeof AudioContext;
      };
      const Ctx = W.AudioContext ?? W.webkitAudioContext;
      if (!Ctx) return;
      audioRef.current ??= new Ctx();
      if (audioRef.current.state === "suspended")
        void audioRef.current.resume().catch(() => undefined);
    } catch {
      /* audio not available */
    }
  }, []);
  const chime = useCallback(() => {
    const ctx = audioRef.current;
    if (!ctx) return;
    try {
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
  useEffect(
    () => () => {
      void audioRef.current?.close().catch(() => undefined);
      audioRef.current = null;
    },
    [],
  );

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
  const decision = useMemo(() => (ex ? suggestDecision(ex) : null), [ex]);
  const suggested = decision?.nextWeightKg ?? ex?.prescription.loadSuggestionKg ?? null;
  const weight = ex ? (session?.workingWeightKg[ex.id] ?? suggested ?? 0) : 0;
  const setNumber = exSets.length + 1;
  const targetReps = ex ? ex.prescription.repMax : 0;
  const repsToLog = reps ?? targetReps;
  const offline =
    st.lastFlushError === "offline" ||
    (typeof navigator !== "undefined" && navigator.onLine === false);
  const needsAuth = st.lastFlushError === "auth";
  const pendingHere = st.outbox.some((e) => e.workoutId === workoutId);
  // Derived at render time so an acknowledgement that lands before the subscription below is
  // attached still closes the screen (the session itself is cleared on the next mount if needed).
  const view: Phase = phase === "syncing" && !pendingHere ? "closed" : phase;

  // Chime exactly once per rest (a new `restEndsAt` after +30 s chimes again); never for a stale
  // rest restored from IndexedDB.
  useEffect(() => {
    const ends = session?.restEndsAt ?? null;
    if (!ends || restLeft > 0 || lastChimedRef.current === ends) return;
    lastChimedRef.current = ends;
    if (Date.now() - ends < 5000) chime();
  }, [restLeft, session?.restEndsAt, chime]);

  // A queued finish that gets acknowledged (global flusher, `online`, "Réessayer") closes the
  // session here too. Driven by the rendered `pendingHere`, after commit — never from inside a
  // store subscriber: zustand notifies synchronously, so a `clearSession()` in the listener
  // re-enters itself until the stack overflows and the flush rejects. `view` already renders
  // "closed"; this only releases the finished session so the next mount does not re-seed it.
  useEffect(() => {
    if (phase !== "syncing" || pendingHere) return;
    useStrengthSession.getState().clearSession();
  }, [phase, pendingHere]);

  if (view === "loading")
    return <p className="py-10 text-center text-fg-muted">Chargement de la séance…</p>;

  if (view === "closed") {
    const skipped = bundle?.status === "skipped";
    return (
      <div className="py-6">
        <PageHeader title={session?.title ?? bundle?.title ?? "Séance"} closeHref="/today" />
        <p className="text-lg font-semibold">{skipped ? "Séance sautée." : "Séance terminée."}</p>
        <p className="mt-1 text-sm text-fg-muted">
          {skipped
            ? "Le moteur a replanifié sans elle."
            : "Ton ressenti et tes séries sont enregistrés : cette séance ne peut plus être relancée."}
        </p>
        <Link
          href={`/workouts/${workoutId}`}
          className="mt-4 flex h-14 items-center justify-center rounded-2xl bg-accent text-lg font-semibold text-accent-fg"
        >
          Voir la séance
        </Link>
        <Link href="/today" className="mt-3 block text-center text-sm text-fg-muted">
          Today
        </Link>
      </div>
    );
  }

  if (view === "syncing") {
    const count = st.outbox.filter((e) => e.workoutId === workoutId).length;
    return (
      <div className="py-6">
        <PageHeader title={session?.title ?? bundle?.title ?? "Séance"} closeHref="/today" />
        <p className="text-lg font-semibold">Séance enregistrée — synchronisation en attente.</p>
        <p className="mt-1 text-sm text-fg-muted">
          {count} événement(s) gardé(s) sur ce téléphone
          {needsAuth ? " · reconnecte-toi" : offline ? " · hors ligne" : ""}. Rien n&apos;est perdu
          : l&apos;envoi reprend dès que possible.
        </p>
        {needsAuth ? (
          <Link
            href={`/login?next=/train/strength/${workoutId}`}
            className="mt-4 flex h-14 items-center justify-center rounded-2xl bg-accent text-lg font-semibold text-accent-fg"
          >
            Se reconnecter pour synchroniser
          </Link>
        ) : (
          <Button
            className="mt-4"
            full
            size="lg"
            disabled={st.flushing}
            onClick={() => void st.flushOutbox()}
          >
            {st.flushing ? "Synchronisation…" : "Réessayer maintenant"}
          </Button>
        )}
        <Link href="/today" className="mt-3 block text-center text-sm text-fg-muted">
          Today
        </Link>
      </div>
    );
  }

  if (view === "conflict" && session) {
    const otherSets = session.sets.filter((s) => !s.isWarmup).length;
    // No working set: the other session was never performed. Its finish (no RPE, no set) sends the
    // workout back to `planned` server-side instead of a done workout with an invented load.
    const abandon = otherSets === 0;
    return (
      <div className="py-6">
        <PageHeader title="Séance en cours" closeHref="/today" />
        <p className="text-lg font-semibold">Une autre séance est déjà en cours.</p>
        <p className="mt-1 text-sm text-fg-muted">
          {abandon
            ? `« ${session.title} » a été démarrée sans aucune série. Reprends-la, ou abandonne-la (elle redevient planifiée) avant de démarrer celle-ci.`
            : `« ${session.title} » (${otherSets} série(s)) n'a pas été terminée. Reprends-la, ou termine-la sans ressenti avant de démarrer celle-ci.`}
        </p>
        <div className="mt-4 flex flex-col gap-2">
          <Button
            size="lg"
            full
            onClick={() => router.replace(`/train/strength/${session.workoutId}`)}
          >
            Reprendre « {session.title} »
          </Button>
          <Button
            variant="outline"
            size="lg"
            full
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const s = useStrengthSession.getState();
              s.finishSession({ rpe: null, feeling: null, painReported: false, notes: "" });
              await s.flushOutbox();
              useStrengthSession.getState().clearSession();
              setPhase(resolvePhase(bundle, workoutId, userId));
              setBusy(false);
            }}
          >
            {busy
              ? "…"
              : abandon
                ? "Abandonner l'autre et démarrer"
                : "Terminer l'autre puis démarrer"}
          </Button>
        </div>
      </div>
    );
  }

  if (view === "none" || !session || !ex) {
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
    unlockAudio();
    const set = st.completeSet(ex.id, repsToLog, weight, isWarmup);
    setReps(null);
    void st.flushOutbox();
    return set;
  };
  const rate = (q: SetQuality) => {
    if (!lastSet) return;
    unlockAudio();
    st.rateLastSet(lastSet.id, q);
    void st.flushOutbox();
  };
  const last = ex.lastExposure?.sets.at(-1) ?? null;
  const allSetsDone = exSets.length >= ex.prescription.sets;
  const isLastExercise = session.currentExerciseIndex >= session.exercises.length - 1;
  const totalSets = session.exercises.reduce((a, e) => a + e.prescription.sets, 0);
  const doneSets = session.sets.filter((s) => !s.isWarmup).length;
  const bigStep = ex.incrementKg * 2;
  const adjusted = suggested != null && weight !== suggested;

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
        <div className="mt-2 flex justify-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            aria-label={`-${bigStep} kg`}
            onClick={() => st.adjustWeight(ex.id, -bigStep)}
          >
            −{bigStep} kg
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`+${bigStep} kg`}
            onClick={() => st.adjustWeight(ex.id, bigStep)}
          >
            +{bigStep} kg
          </Button>
        </div>
        {decision && exSets.length === 0 ? (
          <p className="mx-auto mt-2 max-w-xs text-xs text-fg-subtle">
            {adjusted && suggested != null
              ? `Proposé : ${formatKg(suggested)} · ajusté à la main.`
              : decision.reason}
          </p>
        ) : null}
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
              <Button
                variant="ghost"
                onClick={() => {
                  unlockAudio();
                  st.extendRest(30);
                }}
              >
                +30 s
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  unlockAudio();
                  st.skipRest();
                }}
              >
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
            {needsAuth ? (
              <>
                {" · "}
                <Link
                  href={`/login?next=/train/strength/${workoutId}`}
                  className="underline underline-offset-2"
                >
                  reconnecte-toi
                </Link>
              </>
            ) : offline ? (
              " · hors ligne"
            ) : (
              ""
            )}
          </p>
        ) : null}
      </div>

      {finishOpen ? (
        <FinishSheet
          onClose={() => setFinishOpen(false)}
          onFinish={async (finish) => {
            st.finishSession(finish);
            await st.flushOutbox();
            setFinishOpen(false);
            if (hasPendingEvents(workoutId)) {
              // Offline / 401: keep the finished session and its events; never re-seed on return.
              setPhase("syncing");
              return;
            }
            useStrengthSession.getState().clearSession();
            // replace: the finished shell must not stay in history behind the workout page.
            router.replace(`/workouts/${workoutId}`);
          }}
        />
      ) : null}
    </div>
  );
}
