"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { logQuickWorkoutAction } from "@/app/(app)/log/actions";
import { Button } from "@/components/ui/button";
import { CANDIDATE_CATALOG } from "@/domain/engine";
import type { IntensityBand } from "@/domain/core";
import { cn } from "@/lib/cn";
import {
  ErrorNote,
  FeelingPicker,
  Field,
  Segmented,
  Slider,
  Stepper,
  TextInput,
  errorMessage,
  type FeelingValue,
} from "./fields";

type QuickType = "cardio" | "free" | "mobility";

const TYPES: ReadonlyArray<{ value: QuickType; label: string }> = [
  { value: "cardio", label: "Cardio" },
  { value: "free", label: "Libre" },
  { value: "mobility", label: "Mobilité" },
];
const INTENSITIES: ReadonlyArray<{ value: IntensityBand; label: string }> = [
  { value: "easy", label: "facile" },
  { value: "moderate", label: "modéré" },
  { value: "hard", label: "dur" },
];

const CARDIO_MODALITIES = new Set(["running", "bike", "row", "ski", "swimming"]);
const FREE_MODALITIES = new Set(["mixed_modal", "other", "walking"]);
const EXCLUDED_FAMILIES = new Set(["partner", "benchmark", "crossfit", "rest", "test"]);

/** Catalog kinds a quick log can be tagged with, per type (titles are already French). */
function kindsFor(type: QuickType) {
  return CANDIDATE_CATALOG.filter((c) => {
    if (EXCLUDED_FAMILIES.has(c.family)) return false;
    if (type === "cardio") return CARDIO_MODALITIES.has(c.modality);
    if (type === "mobility") return c.modality === "mobility";
    return FREE_MODALITIES.has(c.modality);
  });
}

/** "+ Enregistrer une activité": kind chips or a free title, duration, intensity, RPE, feeling. */
export function ActivityForm({ today }: { today: string }) {
  const [date, setDate] = useState(today);
  const [type, setType] = useState<QuickType>("cardio");
  const [kind, setKind] = useState<string | null>("run_easy_45");
  const [title, setTitle] = useState("");
  const [durationMin, setDurationMin] = useState(45);
  const [intensity, setIntensity] = useState<IntensityBand>("easy");
  const [rpe, setRpe] = useState(4);
  const [feeling, setFeeling] = useState<FeelingValue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, run] = useTransition();

  const kinds = useMemo(() => kindsFor(type), [type]);
  const selected = kinds.find((k) => k.kind === kind) ?? null;
  const finalTitle = title.trim() || selected?.title || "";

  function pickType(t: QuickType) {
    setType(t);
    const first = kindsFor(t)[0];
    setKind(first?.kind ?? null);
    if (first) {
      setDurationMin(first.durationMin);
      setIntensity(first.intensity);
    }
  }

  function pickKind(k: (typeof kinds)[number]) {
    setKind(k.kind);
    setDurationMin(k.durationMin);
    setIntensity(k.intensity);
  }

  function submit() {
    setError(null);
    run(async () => {
      try {
        await logQuickWorkoutAction({
          date,
          type,
          kind: selected?.kind ?? null,
          title: finalTitle,
          durationMin,
          intensity,
          rpe,
          feeling,
        });
      } catch (e) {
        setError(errorMessage(e));
      }
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <TextInput label="Date" type="date" value={date} onChange={setDate} max={today} />
      <Segmented label="Type" value={type} options={TYPES} onChange={pickType} columns={3} />
      <Field label="Quoi ?" hint="Choisis une séance type ou écris un titre libre.">
        <div className="flex flex-wrap gap-1.5">
          {kinds.map((k) => (
            <button
              key={k.kind}
              type="button"
              aria-pressed={kind === k.kind}
              onClick={() => pickKind(k)}
              className={cn(
                "h-11 rounded-full px-3.5 text-sm font-semibold",
                kind === k.kind ? "bg-accent text-accent-fg" : "bg-bg-muted text-fg-muted",
              )}
            >
              {k.title}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={kind === null}
            onClick={() => setKind(null)}
            className={cn(
              "h-11 rounded-full px-3.5 text-sm font-semibold",
              kind === null ? "bg-accent text-accent-fg" : "bg-bg-muted text-fg-muted",
            )}
          >
            Autre
          </button>
        </div>
      </Field>
      <TextInput
        label="Titre"
        value={title}
        onChange={setTitle}
        placeholder={selected?.title ?? "ex. Randonnée, foot avec les enfants…"}
      />
      <Stepper
        label="Durée"
        value={durationMin}
        onChange={setDurationMin}
        step={5}
        min={5}
        max={300}
      />
      <Segmented
        label="Intensité"
        value={intensity}
        options={INTENSITIES}
        onChange={setIntensity}
        columns={3}
      />
      <Slider label="RPE" value={rpe} onChange={setRpe} min={1} max={10} />
      <FeelingPicker value={feeling} onChange={setFeeling} />
      <ErrorNote message={error} />
      <Button size="lg" full disabled={pending || !finalTitle} onClick={submit}>
        {pending ? "…" : "Enregistrer"}
      </Button>
      <Link
        href="/activities/import"
        className="text-center text-sm text-fg-muted underline-offset-4 hover:underline"
      >
        Importer un fichier FIT
      </Link>
    </div>
  );
}
