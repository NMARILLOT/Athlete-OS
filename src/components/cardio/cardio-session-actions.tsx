"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { completeCardioAction, startCardioAction } from "@/app/(app)/train/cardio/actions";
import { FinishSheet } from "@/components/strength/finish-sheet";
import { Button } from "@/components/ui/button";
import type { WorkoutStatus } from "@/domain/core";
import { formatDurationSec, formatMinutes } from "@/lib/format";

/** Seconds since `startAt`, ticking every second; null until the first client tick (no hydration mismatch). */
function useElapsedSec(startAt: string | null): number | null {
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    if (!startAt) return;
    const tick = () => setNowMs(Date.now());
    const first = window.setTimeout(tick, 0);
    const id = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [startAt]);
  if (!startAt || nowMs == null) return null;
  const startMs = Date.parse(startAt);
  if (Number.isNaN(startMs)) return null;
  return Math.max(0, Math.floor((nowMs - startMs) / 1000));
}

/**
 * "Démarrer" → in progress (the watch does the guiding; the app keeps the clock), "Terminer" →
 * spec §22 feedback sheet → actual duration from the elapsed time → recompute → workout page.
 */
export function CardioSessionActions({
  id,
  status,
  startAt,
  plannedDurationMin,
}: {
  id: string;
  status: WorkoutStatus;
  startAt: string | null;
  plannedDurationMin: number | null;
}) {
  const router = useRouter();
  const [sheet, setSheet] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, run] = useTransition();
  const inProgress = status === "in_progress";
  const elapsed = useElapsedSec(inProgress ? startAt : null);

  if (status === "done") return null;
  if (status === "skipped")
    return (
      <p className="text-sm text-fg-muted">Séance sautée. Le moteur a replanifié sans elle.</p>
    );

  function start() {
    setError(null);
    run(async () => {
      try {
        await startCardioAction(id);
        router.refresh();
      } catch {
        setError("Impossible de démarrer. Réessaie.");
      }
    });
  }

  async function finish(f: {
    rpe: number | null;
    feeling: "great" | "good" | "meh" | "too_hard" | null;
    painReported: boolean;
    notes: string;
  }) {
    try {
      const { href } = await completeCardioAction({
        workoutId: id,
        rpe: f.rpe,
        feeling: f.feeling,
        painReported: f.painReported,
        notes: f.notes || undefined,
      });
      setSheet(false);
      router.push(href);
    } catch {
      setSheet(false);
      setError("Impossible d'enregistrer le ressenti. Réessaie.");
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {inProgress ? (
        <div className="flex items-center justify-between rounded-2xl bg-bg-muted px-4 py-3">
          <span className="text-sm text-fg-muted">
            En cours
            {plannedDurationMin ? ` · prévu ${formatMinutes(plannedDurationMin)}` : ""}
          </span>
          <span className="text-2xl font-semibold tabular-nums" aria-live="off">
            {elapsed != null ? formatDurationSec(elapsed) : "—"}
          </span>
        </div>
      ) : (
        <Button size="lg" full disabled={pending} onClick={start}>
          {pending ? "…" : "Démarrer"}
        </Button>
      )}
      <Button
        size="lg"
        full
        variant={inProgress ? "primary" : "secondary"}
        disabled={pending}
        onClick={() => {
          setError(null);
          setSheet(true);
        }}
      >
        Terminer
      </Button>
      {!inProgress ? (
        <p className="text-center text-[11px] text-fg-subtle">
          Terminer sans démarrer enregistre la durée prévue.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {sheet ? <FinishSheet onClose={() => setSheet(false)} onFinish={finish} /> : null}
    </div>
  );
}
