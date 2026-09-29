"use client";

import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { isNextRedirect } from "@/lib/next-redirect";

/**
 * Small form primitives shared by the "+" palette log pages: big touch targets (≥ 44 px),
 * labelled inputs, minimal typing (segments, steppers, sliders).
 */

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-xs font-semibold tracking-wide text-fg-muted uppercase">{label}</span>
      {children}
      {hint ? <span className="text-[11px] text-fg-subtle">{hint}</span> : null}
    </div>
  );
}

export const INPUT_CLASS =
  "h-12 w-full rounded-xl border border-border bg-bg-muted/60 px-3 text-base text-fg outline-none focus:border-accent";

export function TextInput({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  step,
  min,
  max,
  inputMode,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "number" | "date" | "time" | "datetime-local";
  placeholder?: string;
  step?: number | string;
  min?: number | string;
  max?: number | string;
  inputMode?: "decimal" | "numeric" | "text";
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-semibold tracking-wide text-fg-muted uppercase">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        step={step}
        min={min}
        max={max}
        inputMode={inputMode}
        className={INPUT_CLASS}
      />
      {hint ? <span className="text-[11px] text-fg-subtle">{hint}</span> : null}
    </div>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  columns,
}: {
  label: string;
  value: T | null;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  columns?: 2 | 3 | 4 | 5;
}) {
  return (
    <Field label={label}>
      <div
        role="radiogroup"
        aria-label={label}
        className={cn(
          "grid gap-1.5",
          columns === 2 && "grid-cols-2",
          columns === 3 && "grid-cols-3",
          columns === 4 && "grid-cols-4",
          columns === 5 && "grid-cols-5",
          !columns && "auto-cols-fr grid-flow-col",
        )}
      >
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              "h-12 rounded-xl px-2 text-sm font-semibold transition-colors",
              value === o.value ? "bg-accent text-accent-fg" : "bg-bg-muted text-fg-muted",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </Field>
  );
}

export function Stepper({
  label,
  value,
  onChange,
  step = 5,
  min = 0,
  max = 600,
  unit = "min",
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  hint?: string;
}) {
  const id = useId();
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  return (
    <Field label={label} hint={hint}>
      <div className="flex h-14 items-center overflow-hidden rounded-2xl bg-bg-muted">
        <button
          type="button"
          aria-label={`Moins ${step} ${unit}`}
          onClick={() => onChange(clamp(value - step))}
          className="h-full w-14 text-2xl font-semibold text-fg-muted active:bg-border"
        >
          −
        </button>
        <label htmlFor={id} className="sr-only">
          {label}
        </label>
        <input
          id={id}
          type="number"
          inputMode="numeric"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => onChange(clamp(Number(e.target.value) || min))}
          className="h-full min-w-0 flex-1 bg-transparent text-center text-2xl font-semibold text-fg tabular-nums outline-none"
        />
        <span className="pr-1 text-sm text-fg-muted">{unit}</span>
        <button
          type="button"
          aria-label={`Plus ${step} ${unit}`}
          onClick={() => onChange(clamp(value + step))}
          className="h-full w-14 text-2xl font-semibold text-fg-muted active:bg-border"
        >
          +
        </button>
      </div>
    </Field>
  );
}

export function Slider({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  display,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  display?: (v: number) => string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label htmlFor={id} className="text-xs font-semibold tracking-wide text-fg-muted uppercase">
          {label}
        </label>
        <span className="text-xl font-semibold tabular-nums">
          {display ? display(value) : value}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-11 w-full accent-accent"
      />
    </div>
  );
}

export function Toggle({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {hint ? <p className="text-[11px] text-fg-subtle">{hint}</p> : null}
      </div>
      <div className="flex gap-1.5" role="radiogroup" aria-label={label}>
        <button
          type="button"
          role="radio"
          aria-checked={!value}
          onClick={() => onChange(false)}
          className={cn(
            "h-11 rounded-xl px-4 text-sm font-semibold",
            !value ? "bg-accent text-accent-fg" : "bg-bg-muted text-fg-muted",
          )}
        >
          Non
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={value}
          onClick={() => onChange(true)}
          className={cn(
            "h-11 rounded-xl px-4 text-sm font-semibold",
            value ? "bg-warn/20 text-warn" : "bg-bg-muted text-fg-muted",
          )}
        >
          Oui
        </button>
      </div>
    </div>
  );
}

export type FeelingValue = "great" | "good" | "meh" | "too_hard";
export const FEELING_OPTIONS: ReadonlyArray<{ value: FeelingValue; label: string }> = [
  { value: "great", label: "😍 Trop bien" },
  { value: "good", label: "🙂 Bien" },
  { value: "meh", label: "😐 Moyen" },
  { value: "too_hard", label: "😵 Trop dur" },
];

export function FeelingPicker({
  value,
  onChange,
}: {
  value: FeelingValue | null;
  onChange: (v: FeelingValue) => void;
}) {
  return (
    <Field label="Comment c'était ?">
      <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Ressenti">
        {FEELING_OPTIONS.map((f) => (
          <button
            key={f.value}
            type="button"
            role="radio"
            aria-checked={value === f.value}
            onClick={() => onChange(f.value)}
            className={cn(
              "h-14 rounded-2xl text-base font-semibold",
              value === f.value ? "bg-accent text-accent-fg" : "bg-bg-muted",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
    </Field>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
      {message}
    </p>
  );
}

/**
 * Server actions throw a generic error on validation; keep the French message short. A server
 * `redirect()` also rejects the action promise (the navigation still happens): that is a success,
 * so no message is shown for it.
 */
export function errorMessage(err: unknown): string | null {
  if (isNextRedirect(err)) return null;
  if (err instanceof Error && err.message)
    return "Impossible d'enregistrer. Vérifie les valeurs et réessaie.";
  return "Impossible d'enregistrer. Réessaie.";
}
