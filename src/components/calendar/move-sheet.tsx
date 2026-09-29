"use client";

import { isNextRedirect } from "@/lib/next-redirect";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { CalendarClock } from "lucide-react";
import { checkMoveAction, moveWorkoutAction } from "@/app/(app)/calendar/actions";
import { Button } from "@/components/ui/button";
import { addDays } from "@/domain/core/dates";
import { cn } from "@/lib/cn";
import { formatDateShort } from "@/lib/format";

type MoveCheck = Awaited<ReturnType<typeof checkMoveAction>>;

/**
 * "Déplacer" → bottom sheet with the next 7 days; picking one asks the engine (`checkPlacement`)
 * and shows the verdict. A veto is advice, not a lock (spec §53): the athlete can still confirm,
 * labelled "Déconseillé". Structurally impossible moves show no confirm button.
 */
export function MoveButton({
  workoutId,
  title,
  fromDate,
  today,
}: {
  workoutId: string;
  title: string;
  fromDate: string;
  today: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const [check, setCheck] = useState<MoveCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, startCheck] = useTransition();
  const [moving, startMove] = useTransition();
  const candidates = Array.from({ length: 7 }, (_, i) => addDays(today, i)).filter(
    (d) => d !== fromDate,
  );

  function close() {
    setOpen(false);
    setTarget(null);
    setCheck(null);
    setError(null);
  }

  function choose(date: string) {
    setTarget(date);
    setCheck(null);
    setError(null);
    startCheck(async () => {
      try {
        setCheck(await checkMoveAction(workoutId, date));
      } catch {
        setError("Vérification impossible pour l'instant.");
      }
    });
  }

  function confirm(force: boolean) {
    if (!target) return;
    setError(null);
    startMove(async () => {
      try {
        const res = await moveWorkoutAction(workoutId, target, force);
        if (res.ok) {
          close();
          router.refresh();
        } else {
          setError(res.message);
        }
      } catch (err) {
        if (isNextRedirect(err)) throw err;
        setError("Déplacement impossible pour le moment. Vérifie ta connexion et réessaie.");
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Déplacer ${title}`}
        className="flex min-h-14 w-16 shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl bg-bg-muted text-[11px] font-semibold text-fg-muted hover:text-fg"
      >
        <CalendarClock className="size-5" aria-hidden />
        Déplacer
      </button>
      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={`move-${workoutId}`}
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60"
          onClick={close}
        >
          <div
            className="pb-safe w-full max-w-lg rounded-t-3xl bg-bg-elevated p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id={`move-${workoutId}`} className="text-lg font-semibold">
              Déplacer « {title} »
            </h2>
            <p className="mt-1 text-sm text-fg-muted">
              Actuellement {formatDateShort(fromDate)}. Choisis un jour : le moteur vérifie les
              interférences avant de confirmer.
            </p>
            <ul className="mt-3 grid grid-cols-2 gap-2">
              {candidates.map((d) => (
                <li key={d}>
                  <button
                    type="button"
                    aria-pressed={target === d}
                    disabled={moving}
                    onClick={() => choose(d)}
                    className={cn(
                      "h-12 w-full rounded-xl text-sm font-semibold capitalize disabled:opacity-50",
                      target === d ? "bg-accent text-accent-fg" : "bg-bg-muted text-fg",
                    )}
                  >
                    {formatDateShort(d)}
                    {d === today ? " (auj.)" : ""}
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-4 min-h-12" aria-live="polite">
              {checking ? (
                <p className="text-sm text-fg-muted">Vérification…</p>
              ) : check ? (
                <Verdict check={check} />
              ) : (
                <p className="text-sm text-fg-subtle">Sélectionne un jour.</p>
              )}
              {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
            </div>
            <div className="mt-4 flex gap-2">
              {check && !checking ? (
                <ConfirmButton check={check} moving={moving} onConfirm={confirm} />
              ) : null}
              <Button variant="ghost" size="lg" onClick={close} disabled={moving}>
                Annuler
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function outcomeMessages(check: MoveCheck): string[] {
  return check.verdict.outcomes
    .filter((o) => o.effect === "veto" || o.effect === "note" || (o.score ?? 0) <= -3)
    .map((o) => o.message);
}

function Verdict({ check }: { check: MoveCheck }) {
  const v = check.verdict;
  if (v.verdict === "ok")
    return (
      <div className="rounded-xl bg-accent/15 px-3 py-2 text-sm font-semibold text-accent">
        OK, aucune interférence
      </div>
    );
  const messages = outcomeMessages(check);
  if (v.verdict === "warn")
    return (
      <div className="rounded-xl bg-warn/15 px-3 py-2 text-sm text-warn">
        <p className="font-semibold">Possible, mais attention</p>
        <ul className="mt-1 list-disc pl-4">
          {messages.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      </div>
    );
  return (
    <div className="rounded-xl bg-danger/15 px-3 py-2 text-sm text-danger">
      <p className="font-semibold">{check.movable ? "Déconseillé" : "Impossible"}</p>
      <p className="mt-1">{v.summary}</p>
      {messages.length > 1 ? (
        <ul className="mt-1 list-disc pl-4">
          {messages.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ConfirmButton({
  check,
  moving,
  onConfirm,
}: {
  check: MoveCheck;
  moving: boolean;
  onConfirm: (force: boolean) => void;
}) {
  if (!check.movable) return null;
  const v = check.verdict.verdict;
  if (v === "ok")
    return (
      <Button size="lg" className="flex-1" disabled={moving} onClick={() => onConfirm(false)}>
        {moving ? "…" : "Déplacer"}
      </Button>
    );
  return (
    <Button
      size="lg"
      variant={v === "warn" ? "outline" : "danger"}
      className="flex-1"
      disabled={moving}
      onClick={() => onConfirm(v === "veto")}
    >
      {moving ? "…" : "Déplacer quand même"}
    </Button>
  );
}
