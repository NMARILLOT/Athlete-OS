"use client";

import { useId, type ReactNode } from "react";
import {
  CARDIO_STEP_KIND_VALUES,
  CARDIO_TARGET_TYPE_VALUES,
  type CardioLeafKind,
  type CardioStep,
  type CardioStepKind,
  type CardioTarget,
  type CardioTargetType,
  type HrZone,
} from "@/domain/cardio";
import { cn } from "@/lib/cn";
import { STEP_KIND_FR, TARGET_TYPE_FR, describeExtent, describeTarget } from "./labels";

/**
 * Editable step list of the cardio builder (spec §80): kind, duration / distance / lap button,
 * target (zone, bpm, pace, power, cadence, open), notes, repeats with inner steps. Reorder is by
 * buttons (one-hand, no drag). All inputs are controlled numbers so index keys stay correct.
 */

/** A repeat may not nest another repeat: the watch executes one level cleanly and the UI stays readable. */
const MAX_REPEAT_DEPTH = 1;
const ZONES = [1, 2, 3, 4, 5] as const;

type Extent = "time" | "distance" | "lap";
const EXTENTS: ReadonlyArray<{ value: Extent; label: string }> = [
  { value: "time", label: "Durée" },
  { value: "distance", label: "Distance" },
  { value: "lap", label: "Bouton lap" },
];

function isStepKind(v: string): v is CardioStepKind {
  return (CARDIO_STEP_KIND_VALUES as readonly string[]).includes(v);
}

const zone = (z: number): CardioTarget => ({ type: "hr_zone", zone: z });

export function leafStep(
  kind: CardioLeafKind,
  durationSec: number,
  target: CardioTarget,
): CardioStep {
  return { kind, durationSec, target };
}

export function repeatStep(times: number, steps: CardioStep[]): CardioStep {
  return { kind: "repeat", repeat: { times, steps } };
}

/** After an effort comes a recovery; anything else starts a new effort. */
function defaultLeaf(steps: readonly CardioStep[]): CardioStep {
  const last = steps[steps.length - 1];
  return last?.kind === "work"
    ? leafStep("recovery", 120, zone(1))
    : leafStep("work", 600, zone(2));
}

function defaultRepeat(): CardioStep {
  return repeatStep(4, [leafStep("work", 180, zone(4)), leafStep("recovery", 120, zone(1))]);
}

function defaultTarget(type: CardioTargetType): CardioTarget {
  switch (type) {
    case "hr_zone":
      return zone(2);
    case "hr_bpm":
      return { type, min: 130, max: 150 };
    case "pace_sec_km":
      return { type, min: 270, max: 300 };
    case "power_w":
      return { type, min: 150, max: 200 };
    case "cadence":
      return { type, min: 170, max: 180 };
    case "open":
      return { type };
  }
}

function extentOf(step: CardioStep): Extent {
  if (step.durationSec != null && step.durationSec > 0) return "time";
  if (step.distanceM != null && step.distanceM > 0) return "distance";
  return "lap";
}

export function StepList({
  steps,
  depth,
  zones,
  onChange,
}: {
  steps: CardioStep[];
  depth: number;
  zones: readonly HrZone[] | null;
  onChange: (steps: CardioStep[]) => void;
}) {
  const update = (i: number, step: CardioStep) =>
    onChange(steps.map((s, j) => (j === i ? step : s)));
  const remove = (i: number) => onChange(steps.filter((_, j) => j !== i));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    const a = steps[i];
    const b = steps[j];
    if (!a || !b) return;
    const next = [...steps];
    next[i] = b;
    next[j] = a;
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-2">
      {steps.length === 0 ? (
        <p className="text-sm text-fg-muted">Aucune étape : ajoute au moins un effort.</p>
      ) : null}
      {steps.map((s, i) => (
        <StepEditor
          key={i}
          step={s}
          index={i}
          count={steps.length}
          depth={depth}
          zones={zones}
          onChange={(n) => update(i, n)}
          onRemove={() => remove(i)}
          onMove={(d) => move(i, d)}
        />
      ))}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onChange([...steps, defaultLeaf(steps)])}
          className="h-11 flex-1 rounded-xl border border-dashed border-border-strong text-sm font-semibold text-fg-muted hover:text-fg"
        >
          + Étape
        </button>
        {depth < MAX_REPEAT_DEPTH ? (
          <button
            type="button"
            onClick={() => onChange([...steps, defaultRepeat()])}
            className="h-11 flex-1 rounded-xl border border-dashed border-border-strong text-sm font-semibold text-fg-muted hover:text-fg"
          >
            + Répétition
          </button>
        ) : null}
      </div>
    </div>
  );
}

function StepEditor({
  step,
  index,
  count,
  depth,
  zones,
  onChange,
  onRemove,
  onMove,
}: {
  step: CardioStep;
  index: number;
  count: number;
  depth: number;
  zones: readonly HrZone[] | null;
  onChange: (step: CardioStep) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const kindId = useId();
  const isRepeat = step.kind === "repeat";
  const kinds = CARDIO_STEP_KIND_VALUES.filter((k) => k !== "repeat" || depth < MAX_REPEAT_DEPTH);

  function setKind(value: string) {
    if (!isStepKind(value)) return;
    if (value === "repeat") onChange(defaultRepeat());
    else if (isRepeat) onChange(leafStep(value, 600, zone(2)));
    else onChange({ ...step, kind: value });
  }

  return (
    <div
      className={cn(
        "rounded-2xl border border-border p-3",
        depth > 0 ? "bg-bg-muted/40" : "bg-bg-elevated",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="w-5 text-center text-xs font-semibold text-fg-subtle tabular-nums">
          {index + 1}
        </span>
        <label htmlFor={kindId} className="sr-only">
          Type d&apos;étape
        </label>
        <select
          id={kindId}
          value={step.kind}
          onChange={(e) => setKind(e.target.value)}
          className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-bg-muted/60 px-3 text-sm font-semibold text-fg outline-none focus:border-accent"
        >
          {kinds.map((k) => (
            <option key={k} value={k}>
              {STEP_KIND_FR[k]}
            </option>
          ))}
        </select>
        <IconButton label="Monter" disabled={index === 0} onClick={() => onMove(-1)}>
          ↑
        </IconButton>
        <IconButton label="Descendre" disabled={index === count - 1} onClick={() => onMove(1)}>
          ↓
        </IconButton>
        <IconButton label="Supprimer" onClick={onRemove}>
          ×
        </IconButton>
      </div>

      {isRepeat ? (
        <div className="mt-3 flex flex-col gap-2">
          <NumberField
            label="Nombre de répétitions"
            value={step.repeat?.times ?? 1}
            min={1}
            max={100}
            unit="×"
            onChange={(v) =>
              onChange({ ...step, repeat: { times: v, steps: step.repeat?.steps ?? [] } })
            }
          />
          <div className="border-l-2 border-border-strong pl-2">
            <StepList
              steps={step.repeat?.steps ?? []}
              depth={depth + 1}
              zones={zones}
              onChange={(steps) =>
                onChange({ ...step, repeat: { times: step.repeat?.times ?? 1, steps } })
              }
            />
          </div>
        </div>
      ) : (
        <LeafFields step={step} zones={zones} onChange={onChange} />
      )}
    </div>
  );
}

function LeafFields({
  step,
  zones,
  onChange,
}: {
  step: CardioStep;
  zones: readonly HrZone[] | null;
  onChange: (step: CardioStep) => void;
}) {
  const extent = extentOf(step);
  const durationSec = step.durationSec ?? 0;
  const minutes = Math.floor(durationSec / 60);
  const seconds = Math.round(durationSec % 60);
  const target: CardioTarget = step.target ?? { type: "open" };

  function setExtent(e: Extent) {
    if (e === extent) return;
    if (e === "time") onChange({ ...step, durationSec: 600, distanceM: null });
    else if (e === "distance") onChange({ ...step, durationSec: null, distanceM: 1000 });
    else onChange({ ...step, durationSec: null, distanceM: null });
  }
  function setDuration(m: number, s: number) {
    onChange({ ...step, durationSec: Math.max(1, m * 60 + s), distanceM: null });
  }
  function setTarget(t: CardioTarget) {
    onChange({ ...step, target: t });
  }
  function setNotes(value: string) {
    const { notes: _notes, ...rest } = step;
    onChange(value ? { ...rest, notes: value.slice(0, 300) } : rest);
  }

  return (
    <div className="mt-3 flex flex-col gap-3">
      <Segment
        label="Fin de l'étape"
        value={extent}
        options={EXTENTS}
        onChange={setExtent}
        columns={3}
      />
      {extent === "time" ? (
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Minutes"
            value={minutes}
            min={0}
            max={600}
            unit="min"
            onChange={(v) => setDuration(v, seconds)}
          />
          <NumberField
            label="Secondes"
            value={seconds}
            min={0}
            max={59}
            unit="s"
            onChange={(v) => setDuration(minutes, v)}
          />
        </div>
      ) : extent === "distance" ? (
        <NumberField
          label="Distance"
          value={step.distanceM ?? 0}
          min={50}
          max={200_000}
          step={100}
          unit="m"
          onChange={(v) => onChange({ ...step, durationSec: null, distanceM: Math.max(50, v) })}
        />
      ) : (
        <p className="text-sm text-fg-muted">Se termine quand tu appuies sur lap.</p>
      )}

      <Segment
        label="Cible"
        value={target.type}
        options={CARDIO_TARGET_TYPE_VALUES.map((t) => ({ value: t, label: TARGET_TYPE_FR[t] }))}
        onChange={(t) => setTarget(defaultTarget(t))}
        columns={3}
      />
      {target.type === "hr_zone" ? (
        <div role="radiogroup" aria-label="Zone cardiaque" className="grid grid-cols-5 gap-1.5">
          {ZONES.map((z) => (
            <button
              key={z}
              type="button"
              role="radio"
              aria-checked={target.zone === z}
              onClick={() => setTarget(zone(z))}
              className={cn(
                "h-11 rounded-xl text-sm font-semibold",
                target.zone === z ? "bg-accent text-accent-fg" : "bg-bg-muted text-fg-muted",
              )}
            >
              Z{z}
            </button>
          ))}
        </div>
      ) : target.type === "pace_sec_km" ? (
        <PaceRangeFields target={target} onChange={setTarget} />
      ) : target.type === "hr_bpm" || target.type === "power_w" || target.type === "cadence" ? (
        <RangeFields
          target={target}
          unit={target.type === "hr_bpm" ? "bpm" : target.type === "power_w" ? "W" : "/min"}
          max={target.type === "hr_bpm" ? 250 : target.type === "power_w" ? 2000 : 300}
          onChange={setTarget}
        />
      ) : null}

      <input
        type="text"
        aria-label="Note"
        placeholder="Note (optionnel) — ex. trot facile"
        maxLength={300}
        value={step.notes ?? ""}
        onChange={(e) => setNotes(e.target.value)}
        className="h-11 w-full rounded-xl border border-border bg-bg-muted/60 px-3 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
      />
      <p className="text-xs text-fg-subtle">
        {describeExtent(step)} · {describeTarget(step.target, zones)}
      </p>
    </div>
  );
}

function RangeFields({
  target,
  unit,
  max,
  onChange,
}: {
  target: CardioTarget;
  unit: string;
  max: number;
  onChange: (t: CardioTarget) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <NumberField
        label="Min"
        value={target.min ?? 0}
        min={0}
        max={max}
        unit={unit}
        onChange={(v) => onChange({ ...target, min: v })}
      />
      <NumberField
        label="Max"
        value={target.max ?? 0}
        min={0}
        max={max}
        unit={unit}
        onChange={(v) => onChange({ ...target, max: v })}
      />
    </div>
  );
}

/** Pace bounds as min:sec per km; the lower bound is the faster pace (domain convention). */
function PaceRangeFields({
  target,
  onChange,
}: {
  target: CardioTarget;
  onChange: (t: CardioTarget) => void;
}) {
  const fast = target.min ?? 0;
  const slow = target.max ?? 0;
  const set = (key: "min" | "max", m: number, s: number) =>
    onChange({ ...target, [key]: Math.max(0, m * 60 + s) });
  return (
    <div className="grid grid-cols-2 gap-2">
      <PaceField label="Allure rapide" value={fast} onChange={(m, s) => set("min", m, s)} />
      <PaceField label="Allure lente" value={slow} onChange={(m, s) => set("max", m, s)} />
    </div>
  );
}

function PaceField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (m: number, s: number) => void;
}) {
  const m = Math.floor(value / 60);
  const s = Math.round(value % 60);
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
        {label}
      </span>
      <div className="flex items-center gap-1">
        <NumberField
          label={`${label} — minutes`}
          value={m}
          min={0}
          max={30}
          hideLabel
          onChange={(v) => onChange(v, s)}
        />
        <span className="text-fg-muted">:</span>
        <NumberField
          label={`${label} — secondes`}
          value={s}
          min={0}
          max={59}
          hideLabel
          onChange={(v) => onChange(m, v)}
        />
        <span className="text-xs text-fg-muted">/km</span>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  hideLabel,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  hideLabel?: boolean;
}) {
  const id = useId();
  const clamp = (v: number) => Math.max(min, Math.min(max, Number.isFinite(v) ? v : min));
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <label
        htmlFor={id}
        className={cn(
          "text-[11px] font-semibold tracking-wide text-fg-muted uppercase",
          hideLabel && "sr-only",
        )}
      >
        {label}
      </label>
      <div className="flex h-11 items-center rounded-xl border border-border bg-bg-muted/60 px-2 focus-within:border-accent">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => onChange(clamp(Number(e.target.value)))}
          className="h-full min-w-0 flex-1 bg-transparent text-center text-base font-semibold text-fg tabular-nums outline-none"
        />
        {unit ? <span className="pl-1 text-xs text-fg-muted">{unit}</span> : null}
      </div>
    </div>
  );
}

function Segment<T extends string>({
  label,
  value,
  options,
  onChange,
  columns,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  columns: 2 | 3;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
        {label}
      </span>
      <div
        role="radiogroup"
        aria-label={label}
        className={cn("grid gap-1.5", columns === 2 ? "grid-cols-2" : "grid-cols-3")}
      >
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              "h-11 rounded-xl px-2 text-sm font-semibold",
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

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-bg-muted text-lg text-fg-muted hover:text-fg disabled:opacity-30"
    >
      {children}
    </button>
  );
}
