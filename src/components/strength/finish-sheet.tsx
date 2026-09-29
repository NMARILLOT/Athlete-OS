"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

type Feeling = "great" | "good" | "meh" | "too_hard";
const FEELINGS: Array<{ v: Feeling; label: string }> = [
  { v: "great", label: "😍 Trop bien" },
  { v: "good", label: "🙂 Bien" },
  { v: "meh", label: "😐 Moyen" },
  { v: "too_hard", label: "😵 Trop dur" },
];
const RPE_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

/**
 * Spec §22: feeling + RPE + unusual pain, under 10 seconds — three taps.
 * The RPE is a *declared* value: nothing is pre-selected and "Terminer" stays disabled until the
 * athlete has chosen both a feeling and an RPE, so a default can never be stored as declared.
 */
export function FinishSheet({
  onClose,
  onFinish,
  title = "Comment c'était ?",
  initial,
}: {
  onClose: () => void;
  onFinish: (f: {
    rpe: number | null;
    feeling: Feeling | null;
    painReported: boolean;
    notes: string;
  }) => Promise<void> | void;
  title?: string;
  /** Prefill when editing an existing feedback ("Modifier le ressenti"). */
  initial?: { rpe: number | null; feeling: Feeling | null; painReported: boolean } | null;
}) {
  const [feeling, setFeeling] = useState<Feeling | null>(initial?.feeling ?? null);
  const [rpe, setRpe] = useState<number | null>(initial?.rpe ?? null);
  const [pain, setPain] = useState(initial?.painReported ?? false);
  const [busy, setBusy] = useState(false);
  const ready = feeling !== null && rpe !== null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="pb-safe w-full max-w-lg rounded-t-3xl bg-bg-elevated p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">{title}</h2>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {FEELINGS.map((f) => (
            <button
              key={f.v}
              type="button"
              aria-pressed={feeling === f.v}
              onClick={() => setFeeling(f.v)}
              className={
                feeling === f.v
                  ? "h-14 rounded-2xl bg-accent text-base font-semibold text-accent-fg"
                  : "h-14 rounded-2xl bg-bg-muted text-base"
              }
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="mt-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-fg-muted">RPE global</span>
            <span className="text-xl font-semibold tabular-nums">
              {rpe ?? <span className="text-sm font-normal text-fg-subtle">à choisir</span>}
            </span>
          </div>
          <div
            role="radiogroup"
            aria-label="RPE global de 1 (très facile) à 10 (maximal)"
            className="mt-2 grid grid-cols-5 gap-2"
          >
            {RPE_VALUES.map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={rpe === v}
                onClick={() => setRpe(v)}
                className={
                  rpe === v
                    ? "h-12 rounded-xl bg-accent text-lg font-semibold text-accent-fg tabular-nums"
                    : "h-12 rounded-xl bg-bg-muted text-lg tabular-nums"
                }
              >
                {v}
              </button>
            ))}
          </div>
          <p className="mt-1 flex justify-between text-[11px] text-fg-subtle">
            <span>1 · très facile</span>
            <span>10 · maximal</span>
          </p>
        </div>
        <div className="mt-4 flex items-center justify-between">
          <span className="text-sm text-fg-muted">Douleur inhabituelle ?</span>
          <div className="flex gap-2">
            <button
              type="button"
              aria-pressed={!pain}
              onClick={() => setPain(false)}
              className={
                !pain
                  ? "h-10 rounded-xl bg-accent px-4 font-semibold text-accent-fg"
                  : "h-10 rounded-xl bg-bg-muted px-4"
              }
            >
              Non
            </button>
            <button
              type="button"
              aria-pressed={pain}
              onClick={() => setPain(true)}
              className={
                pain
                  ? "h-10 rounded-xl bg-warn/20 px-4 font-semibold text-warn"
                  : "h-10 rounded-xl bg-bg-muted px-4"
              }
            >
              Oui
            </button>
          </div>
        </div>
        <Button
          size="lg"
          full
          className="mt-5"
          disabled={busy || !ready}
          onClick={async () => {
            if (!ready) return;
            setBusy(true);
            await onFinish({ rpe, feeling, painReported: pain, notes: "" });
            setBusy(false);
          }}
        >
          {busy ? "…" : "Terminer"}
        </Button>
        {!ready ? (
          <p className="mt-2 text-center text-[11px] text-fg-subtle">
            Choisis un ressenti et un RPE pour terminer.
          </p>
        ) : null}
      </div>
    </div>
  );
}
