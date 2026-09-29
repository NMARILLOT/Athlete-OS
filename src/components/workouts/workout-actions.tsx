"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { completeWorkoutAction, skipWorkoutAction } from "@/app/(app)/workouts/actions";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { FinishSheet } from "@/components/strength/finish-sheet";
import { FEELING_TO_FUN, type Feeling, type WorkoutStatus, type WorkoutType } from "@/domain/core";
import { ScoreSheet, type ScoreDraft } from "./score-sheet";

const FEELING_FR: Record<Feeling, string> = {
  great: "😍 Trop bien",
  good: "🙂 Bien",
  meh: "😐 Moyen",
  too_hard: "😵 Trop dur",
};

export interface WorkoutActionsProps {
  id: string;
  type: WorkoutType;
  status: WorkoutStatus;
  rpe: number | null;
  feeling: Feeling | null;
  painReported: boolean;
  /** Existing CrossFit score, to prefill "Modifier". */
  score: ScoreDraft | null;
}

/**
 * State-dependent actions of the workout page: start (strength / cardio modes), finish with the
 * spec §22 feedback sheet (CrossFit asks the score first), skip with an inline confirmation, and
 * the done-state feedback with "Modifier le ressenti".
 */
export function WorkoutActions(w: WorkoutActionsProps) {
  const router = useRouter();
  const [pending, run] = useTransition();
  const [step, setStep] = useState<"idle" | "score" | "feedback">("idle");
  const [score, setScore] = useState<ScoreDraft | null>(w.score);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = w.status === "planned" || w.status === "auto_adjusted";
  const finishInline =
    w.type === "crossfit" ||
    w.type === "free" ||
    w.type === "mobility" ||
    w.type === "coach_session";

  function startFeedback() {
    setError(null);
    setStep(w.type === "crossfit" ? "score" : "feedback");
  }

  async function finish(f: {
    rpe: number | null;
    feeling: Feeling | null;
    painReported: boolean;
    notes: string;
  }) {
    try {
      await completeWorkoutAction({
        workoutId: w.id,
        rpe: f.rpe,
        feeling: f.feeling,
        painReported: f.painReported,
        notes: f.notes || undefined,
        score:
          w.type === "crossfit" && score
            ? {
                kind: score.kind,
                value: score.value,
                extraReps: score.extraReps,
                rx: score.rx,
                scaledNotes: score.scaledNotes || undefined,
              }
            : null,
      });
      setStep("idle");
      router.refresh();
    } catch {
      setError("Impossible d'enregistrer le ressenti. Réessaie.");
      setStep("idle");
    }
  }

  function skip() {
    setError(null);
    run(async () => {
      try {
        await skipWorkoutAction(w.id);
        setConfirmSkip(false);
        router.refresh();
      } catch {
        setError("Impossible de sauter la séance. Réessaie.");
      }
    });
  }

  if (w.type === "rest") return null;

  return (
    <>
      {w.status === "done" ? (
        <Card>
          <CardTitle>Ressenti</CardTitle>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <Tile label="Comment" value={w.feeling ? FEELING_FR[w.feeling] : "—"} />
            <Tile label="RPE" value={w.rpe != null ? String(w.rpe) : "—"} />
            <Tile
              label="Fun"
              value={w.feeling ? `${FEELING_TO_FUN[w.feeling]}/10` : "—"}
              hint="déclaré"
            />
          </div>
          {w.painReported ? (
            <p className="mt-2 text-sm text-warn">
              Douleur inhabituelle signalée pendant la séance.
            </p>
          ) : null}
          <Button variant="outline" className="mt-3" full onClick={startFeedback}>
            Modifier le ressenti
          </Button>
        </Card>
      ) : null}

      {w.status === "skipped" ? (
        <p className="text-sm text-fg-muted">Séance sautée. Le moteur a replanifié sans elle.</p>
      ) : null}

      {w.status === "in_progress" && (w.type === "strength" || w.type === "cardio") ? (
        <Link
          href={w.type === "cardio" ? `/train/cardio/${w.id}` : `/train/strength/${w.id}`}
          className="flex h-14 items-center justify-center rounded-2xl bg-accent text-lg font-semibold text-accent-fg"
        >
          Reprendre la séance
        </Link>
      ) : null}

      {open ? (
        <div className="flex flex-col gap-2">
          {w.type === "strength" ? (
            <Link
              href={`/train/strength/${w.id}`}
              className="flex h-14 items-center justify-center rounded-2xl bg-accent text-lg font-semibold text-accent-fg"
            >
              Démarrer
            </Link>
          ) : w.type === "cardio" ? (
            <Link
              href={`/train/cardio/${w.id}`}
              className="flex h-14 items-center justify-center rounded-2xl bg-accent text-lg font-semibold text-accent-fg"
            >
              Démarrer
            </Link>
          ) : finishInline ? (
            <Button size="lg" full onClick={startFeedback}>
              Terminer
            </Button>
          ) : null}
          {confirmSkip ? (
            <div className="flex gap-2">
              <Button
                variant="danger"
                size="lg"
                className="flex-1"
                disabled={pending}
                onClick={skip}
              >
                {pending ? "…" : "Oui, sauter"}
              </Button>
              <Button variant="ghost" size="lg" onClick={() => setConfirmSkip(false)}>
                Annuler
              </Button>
            </div>
          ) : (
            <Button variant="ghost" size="lg" full onClick={() => setConfirmSkip(true)}>
              Sauter
            </Button>
          )}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {step === "score" ? (
        <ScoreSheet
          initial={score}
          onClose={() => setStep("idle")}
          onContinue={(s) => {
            setScore(s);
            setStep("feedback");
          }}
        />
      ) : null}
      {step === "feedback" ? (
        <FinishSheet
          onClose={() => setStep("idle")}
          onFinish={finish}
          initial={
            w.status === "done"
              ? { rpe: w.rpe, feeling: w.feeling, painReported: w.painReported }
              : null
          }
        />
      ) : null}
    </>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl bg-bg-muted/60 px-3 py-2">
      <div className="text-[11px] font-medium tracking-wide text-fg-subtle uppercase">{label}</div>
      <div className="mt-0.5 text-base font-semibold">{value}</div>
      {hint ? <div className="text-[11px] text-fg-subtle">{hint}</div> : null}
    </div>
  );
}
