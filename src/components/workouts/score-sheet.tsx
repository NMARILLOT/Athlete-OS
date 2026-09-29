"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Segmented, TextInput, Toggle } from "@/components/log/fields";

export type ScoreKind = "time" | "rounds_reps" | "reps" | "load";

export interface ScoreDraft {
  kind: ScoreKind;
  /** Seconds (time), rounds (rounds_reps), reps or kg. */
  value: number;
  extraReps: number | null;
  rx: boolean;
  scaledNotes: string;
}

const KINDS: ReadonlyArray<{ value: ScoreKind; label: string }> = [
  { value: "time", label: "Temps" },
  { value: "rounds_reps", label: "Rounds" },
  { value: "reps", label: "Reps" },
  { value: "load", label: "Charge" },
];

function num(v: string): number {
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * CrossFit score (spec §18): asked right before the feedback sheet so the whole flow stays under
 * ten seconds. Skippable — a class without a score is still a done class.
 */
export function ScoreSheet({
  initial,
  onClose,
  onContinue,
}: {
  initial: ScoreDraft | null;
  onClose: () => void;
  onContinue: (score: ScoreDraft | null) => void;
}) {
  const [kind, setKind] = useState<ScoreKind>(initial?.kind ?? "time");
  const [minutes, setMinutes] = useState(
    initial?.kind === "time" ? String(Math.floor(initial.value / 60)) : "",
  );
  const [seconds, setSeconds] = useState(
    initial?.kind === "time" ? String(Math.round(initial.value % 60)) : "",
  );
  const [value, setValue] = useState(
    initial && initial.kind !== "time" ? String(initial.value) : "",
  );
  const [extra, setExtra] = useState(initial?.extraReps ? String(initial.extraReps) : "");
  const [rx, setRx] = useState(initial?.rx ?? true);
  const [notes, setNotes] = useState(initial?.scaledNotes ?? "");

  const numeric = kind === "time" ? num(minutes) * 60 + num(seconds) : num(value);
  const valid = numeric > 0;

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
        <h2 className="text-lg font-semibold">Ton score</h2>
        <div className="mt-3 flex flex-col gap-4">
          <Segmented label="Type" value={kind} options={KINDS} onChange={setKind} columns={4} />
          {kind === "time" ? (
            <div className="grid grid-cols-2 gap-2">
              <TextInput
                label="Minutes"
                type="number"
                inputMode="numeric"
                min={0}
                value={minutes}
                onChange={setMinutes}
                placeholder="0"
              />
              <TextInput
                label="Secondes"
                type="number"
                inputMode="numeric"
                min={0}
                max={59}
                value={seconds}
                onChange={setSeconds}
                placeholder="00"
              />
            </div>
          ) : kind === "rounds_reps" ? (
            <div className="grid grid-cols-2 gap-2">
              <TextInput
                label="Rounds"
                type="number"
                inputMode="numeric"
                min={0}
                value={value}
                onChange={setValue}
                placeholder="0"
              />
              <TextInput
                label="+ reps"
                type="number"
                inputMode="numeric"
                min={0}
                value={extra}
                onChange={setExtra}
                placeholder="0"
              />
            </div>
          ) : (
            <TextInput
              label={kind === "reps" ? "Reps" : "Charge (kg)"}
              type="number"
              inputMode="decimal"
              min={0}
              step={kind === "load" ? 0.5 : 1}
              value={value}
              onChange={setValue}
              placeholder="0"
            />
          )}
          <Toggle label="RX ?" value={rx} onChange={setRx} />
          {!rx ? (
            <TextInput
              label="Adaptations"
              value={notes}
              onChange={setNotes}
              placeholder="ex. 30 kg, pull-ups en bande"
            />
          ) : null}
        </div>
        <div className="mt-5 flex gap-2">
          <Button
            size="lg"
            className="flex-1"
            disabled={!valid}
            onClick={() =>
              onContinue({
                kind,
                value: numeric,
                extraReps: kind === "rounds_reps" ? num(extra) || null : null,
                rx,
                scaledNotes: rx ? "" : notes.trim(),
              })
            }
          >
            Continuer
          </Button>
          <Button size="lg" variant="ghost" onClick={() => onContinue(null)}>
            Sans score
          </Button>
        </div>
      </div>
    </div>
  );
}
