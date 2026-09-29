"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createCardioWorkoutAction,
  updateCardioSpecAction,
} from "@/app/(app)/train/cardio/actions";
import { ErrorNote, TextInput } from "@/components/log/fields";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Chip, toneFor } from "@/components/ui/chip";
import { Stat } from "@/components/ui/stat";
import {
  CARDIO_PRESETS,
  CardioWorkoutSpecSchema,
  estimateDurationMin,
  expectedLoadProfile,
  type CardioPresetKind,
  type CardioWorkoutSpec,
  type HrZone,
} from "@/domain/cardio";
import { CARDIO_KIND_VALUES, type StimulusKey } from "@/domain/core";
import { STIMULUS_LABEL_FR } from "@/domain/engine";
import { cn } from "@/lib/cn";
import {
  BUILDER_MODALITIES,
  CARDIO_KIND_FR,
  INTENSITY_FR,
  MODALITY_FR,
  PRESET_GROUPS,
} from "./labels";
import { LoadBars } from "./load-bars";
import { StepList, leafStep } from "./step-editor";

/** Preset cards are static: estimate and intensity come from the domain, computed once. */
const PRESET_CARDS = PRESET_GROUPS.map((g) => ({
  title: g.title,
  items: g.kinds.map((kind) => {
    const spec = CARDIO_PRESETS[kind];
    return {
      kind,
      title: spec.title,
      minutes: estimateDurationMin(spec),
      intensity: expectedLoadProfile(spec).intensity,
    };
  }),
}));

function clone(spec: CardioWorkoutSpec): CardioWorkoutSpec {
  return JSON.parse(JSON.stringify(spec)) as CardioWorkoutSpec;
}

function blankSpec(): CardioWorkoutSpec {
  return {
    modality: "running",
    kind: "zone2",
    title: "Séance cardio",
    steps: [leafStep("work", 1800, { type: "hr_zone", zone: 2 })],
  };
}

/** Short French wording for the first validation issue of a spec. */
function issueFr(issue: { message: string; path: PropertyKey[] }): string {
  const m = issue.message;
  if (issue.path[0] === "title") return "donne un titre à la séance";
  if (/min must be ≤ max/.test(m)) return "le minimum doit être inférieur au maximum";
  if (/requires a zone/.test(m)) return "choisis une zone";
  if (/requires repeat/.test(m) || /array/.test(m))
    return "une répétition doit contenir au moins une étape";
  if (/number to be >0|positive/.test(m)) return "durée ou distance invalide";
  return "séance invalide";
}

export interface CardioBuilderProps {
  defaultDate: string;
  /** "HH:MM" or "" for no start time. */
  defaultStart: string;
  initialPreset: CardioPresetKind | null;
  /** Editing an existing planned workout (`?edit=`). */
  initialSpec: CardioWorkoutSpec | null;
  editId: string | null;
  /** Zone set in force on the date, so targets preview as "Z2 (145–152 bpm)". */
  zones: HrZone[] | null;
}

/**
 * Cardio workout builder (spec §80): preset picker → editable steps → live estimate → plan.
 * The preview is the same domain math the server stores (`estimateDurationMin`, `expectedLoadProfile`).
 */
export function CardioBuilder({
  defaultDate,
  defaultStart,
  initialPreset,
  initialSpec,
  editId,
  zones,
}: CardioBuilderProps) {
  const router = useRouter();
  const [presetKind, setPresetKind] = useState<CardioPresetKind | null>(initialPreset);
  const [spec, setSpec] = useState<CardioWorkoutSpec | null>(
    initialSpec ? clone(initialSpec) : initialPreset ? clone(CARDIO_PRESETS[initialPreset]) : null,
  );
  const [showPicker, setShowPicker] = useState(spec === null);
  const [date, setDate] = useState(defaultDate);
  const [start, setStart] = useState(defaultStart);
  const [error, setError] = useState<string | null>(null);
  const [pending, run] = useTransition();

  const preview = useMemo(
    () => (spec ? { minutes: estimateDurationMin(spec), load: expectedLoadProfile(spec) } : null),
    [spec],
  );

  function update(patch: Partial<CardioWorkoutSpec>) {
    setSpec((s) => (s ? { ...s, ...patch } : s));
  }

  function pickPreset(kind: CardioPresetKind) {
    setPresetKind(kind);
    setSpec(clone(CARDIO_PRESETS[kind]));
    setShowPicker(false);
    setError(null);
  }

  function pickBlank() {
    setPresetKind(null);
    setSpec(blankSpec());
    setShowPicker(false);
    setError(null);
  }

  function submit() {
    if (!spec) return;
    const parsed = CardioWorkoutSpecSchema.safeParse(spec);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      setError(`Vérifie les étapes : ${first ? issueFr(first) : "séance invalide"}.`);
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError("Choisis une date.");
      return;
    }
    setError(null);
    run(async () => {
      try {
        const { href } = editId
          ? await updateCardioSpecAction(editId, parsed.data)
          : await createCardioWorkoutAction({
              date,
              start: /^\d{2}:\d{2}$/.test(start) ? start : null,
              spec: parsed.data,
              presetKind,
            });
        router.push(href);
      } catch {
        setError("Impossible d'enregistrer la séance. Réessaie.");
      }
    });
  }

  const presetTitle = presetKind ? CARDIO_PRESETS[presetKind].title : null;

  return (
    <div className="flex flex-col gap-4 pb-8">
      {showPicker ? (
        <PresetPicker selected={presetKind} onPick={pickPreset} onBlank={pickBlank} />
      ) : null}

      {spec && preview ? (
        <>
          {!showPicker ? (
            <div className="flex items-center justify-between gap-3 rounded-2xl bg-bg-muted/60 px-4 py-2">
              <p className="min-w-0 truncate text-sm text-fg-muted">
                Modèle :{" "}
                <span className="font-medium text-fg">{presetTitle ?? "séance libre"}</span>
              </p>
              <button
                type="button"
                onClick={() => setShowPicker(true)}
                className="h-11 shrink-0 text-sm font-semibold text-accent"
              >
                Changer
              </button>
            </div>
          ) : null}

          <Card>
            <CardTitle>Séance</CardTitle>
            <div className="mt-2 flex flex-col gap-3">
              <TextInput
                label="Titre"
                value={spec.title}
                onChange={(v) => update({ title: v.slice(0, 120) })}
                placeholder="Footing Z2 — 45 min"
              />
              <ChipRow
                label="Sport"
                value={spec.modality}
                options={BUILDER_MODALITIES.map((m) => ({ value: m, label: MODALITY_FR[m] }))}
                onChange={(modality) => update({ modality })}
              />
              <ChipRow
                label="Type"
                value={spec.kind}
                options={CARDIO_KIND_VALUES.map((k) => ({ value: k, label: CARDIO_KIND_FR[k] }))}
                onChange={(kind) => update({ kind })}
              />
            </div>
          </Card>

          <Card>
            <CardTitle>Étapes</CardTitle>
            <div className="mt-2">
              <StepList
                steps={spec.steps}
                depth={0}
                zones={zones}
                onChange={(steps) => update({ steps })}
              />
            </div>
            {zones ? null : (
              <p className="mt-2 text-[11px] text-fg-subtle">
                Zones sans bornes bpm : renseigne ta LTHR dans le profil pour guider la montre.
              </p>
            )}
          </Card>

          <Card>
            <CardTitle>Aperçu</CardTitle>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <Stat
                label="Durée"
                value={preview.minutes > 0 ? Math.round(preview.minutes) : null}
                unit="min"
                estimated
                hint={preview.minutes > 0 ? undefined : "au bouton lap"}
              />
              <Stat label="Intensité" value={INTENSITY_FR[preview.load.intensity]} estimated />
              <Stat
                label="Impacts"
                value={Math.round(preview.load.impactUnits * 10) / 10}
                estimated
                hint="unités"
              />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Chip tone={toneFor("cardio", preview.load.intensity)}>
                {INTENSITY_FR[preview.load.intensity]}
              </Chip>
              {(Object.entries(preview.load.expectedCredits) as Array<[StimulusKey, number]>)
                .filter(([, v]) => v > 0)
                .map(([k, v]) => (
                  <Chip key={k} tone="accent">
                    {STIMULUS_LABEL_FR[k]} {v.toFixed(1)}
                  </Chip>
                ))}
            </div>
            <div className="mt-3">
              <LoadBars vector={preview.load.loadVector} />
            </div>
            <p className="mt-1 text-[11px] text-fg-subtle">
              Estimation déterministe à partir des étapes, pas une mesure.
            </p>
          </Card>

          {editId ? (
            <p className="text-sm text-fg-muted">
              Date : {date}. Pour la déplacer, passe par le calendrier.
            </p>
          ) : (
            <Card>
              <CardTitle>Planifier</CardTitle>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <TextInput label="Date" type="date" value={date} onChange={setDate} />
                <TextInput
                  label="Heure"
                  type="time"
                  value={start}
                  onChange={setStart}
                  hint="optionnel"
                />
              </div>
            </Card>
          )}

          <ErrorNote message={error} />
          <Button size="lg" full disabled={pending} onClick={submit}>
            {pending ? "…" : editId ? "Enregistrer les modifications" : "Créer la séance"}
          </Button>
        </>
      ) : null}
    </div>
  );
}

function PresetPicker({
  selected,
  onPick,
  onBlank,
}: {
  selected: CardioPresetKind | null;
  onPick: (kind: CardioPresetKind) => void;
  onBlank: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      {PRESET_CARDS.map((group) => (
        <section key={group.title}>
          <h2 className="mb-2 text-xs font-semibold tracking-[0.14em] text-fg-muted uppercase">
            {group.title}
          </h2>
          <ul className="flex flex-col gap-2">
            {group.items.map((p) => (
              <li key={p.kind}>
                <button
                  type="button"
                  aria-pressed={selected === p.kind}
                  onClick={() => onPick(p.kind)}
                  className={cn(
                    "flex min-h-14 w-full items-center justify-between gap-3 rounded-2xl border bg-bg-elevated px-4 py-2 text-left shadow-[var(--shadow-card)] active:scale-[0.99]",
                    selected === p.kind ? "border-accent" : "border-border",
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{p.title}</span>
                    <span className="block text-xs text-fg-muted">
                      ≈ {Math.round(p.minutes)} min
                    </span>
                  </span>
                  <Chip tone={toneFor("cardio", p.intensity)} className="shrink-0">
                    {INTENSITY_FR[p.intensity]}
                  </Chip>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <button
        type="button"
        onClick={onBlank}
        className="flex h-14 w-full items-center justify-center rounded-2xl border border-dashed border-border-strong font-semibold text-fg-muted hover:text-fg"
      >
        Partir de zéro
      </button>
    </div>
  );
}

function ChipRow<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold tracking-wide text-fg-muted uppercase">{label}</span>
      <div
        role="radiogroup"
        aria-label={label}
        className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4"
      >
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              "h-11 shrink-0 rounded-xl px-4 text-sm font-semibold",
              value === o.value ? "bg-accent text-accent-fg" : "bg-bg-muted text-fg-muted",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
