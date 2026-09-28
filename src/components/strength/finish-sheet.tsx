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

/** Spec §22: feeling + RPE + unusual pain, under 10 seconds. */
export function FinishSheet({
  onClose,
  onFinish,
  title = "Comment c'était ?",
}: {
  onClose: () => void;
  onFinish: (f: {
    rpe: number | null;
    feeling: Feeling | null;
    painReported: boolean;
    notes: string;
  }) => Promise<void> | void;
  title?: string;
}) {
  const [feeling, setFeeling] = useState<Feeling | null>(null);
  const [rpe, setRpe] = useState<number>(7);
  const [pain, setPain] = useState(false);
  const [busy, setBusy] = useState(false);
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
            <span className="text-xl font-semibold tabular-nums">{rpe}</span>
          </div>
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={rpe}
            onChange={(e) => setRpe(Number(e.target.value))}
            className="mt-2 w-full accent-accent"
          />
        </div>
        <div className="mt-4 flex items-center justify-between">
          <span className="text-sm text-fg-muted">Douleur inhabituelle ?</span>
          <div className="flex gap-2">
            <button
              type="button"
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
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onFinish({ rpe, feeling, painReported: pain, notes: "" });
            setBusy(false);
          }}
        >
          {busy ? "…" : "Terminer"}
        </Button>
      </div>
    </div>
  );
}
