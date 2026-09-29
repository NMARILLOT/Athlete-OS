"use client";

import { isNextRedirect } from "@/lib/next-redirect";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Toggle chip with a ≥ 44 px touch target (spec §85). */
export function ToggleChip({
  active,
  onClick,
  children,
  disabled,
  className,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-11 items-center justify-center rounded-full border px-4 text-sm font-semibold transition-colors select-none disabled:opacity-50",
        active
          ? "border-accent bg-accent/15 text-accent"
          : "border-border bg-bg-muted/60 text-fg-muted hover:text-fg",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** −/+ stepper with big buttons; the value is read-only text. */
export function Stepper({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  hint?: string;
  onChange: (v: number) => void;
}) {
  const dec = () => onChange(Math.max(min, Math.round((value - step) * 100) / 100));
  const inc = () => onChange(Math.min(max, Math.round((value + step) * 100) / 100));
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-bg-muted/60 px-3 py-2">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {hint ? <p className="text-xs text-fg-subtle">{hint}</p> : null}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={`Diminuer ${label}`}
          onClick={dec}
          disabled={value <= min}
          className="flex size-11 items-center justify-center rounded-xl bg-bg-elevated text-xl font-semibold disabled:opacity-40"
        >
          −
        </button>
        <span
          className="min-w-12 text-center text-lg font-semibold tabular-nums"
          aria-live="polite"
        >
          {value}
          {unit ? <span className="ml-0.5 text-xs text-fg-muted">{unit}</span> : null}
        </span>
        <button
          type="button"
          aria-label={`Augmenter ${label}`}
          onClick={inc}
          disabled={value >= max}
          className="flex size-11 items-center justify-center rounded-xl bg-bg-elevated text-xl font-semibold disabled:opacity-40"
        >
          +
        </button>
      </div>
    </div>
  );
}

/** Labelled numeric input (decimal keyboard on mobile); empty string = not provided. */
export function NumberField({
  id,
  label,
  value,
  onChange,
  unit,
  placeholder,
  hint,
  step = "any",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  unit?: string;
  placeholder?: string;
  hint?: string;
  step?: string;
}) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1">
      <span className="text-xs text-fg-muted">{label}</span>
      <span className="flex h-12 items-center rounded-xl border border-border bg-bg-muted/60 px-3">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          step={step}
          min={0}
          value={value}
          placeholder={placeholder ?? "—"}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-transparent text-base tabular-nums outline-none"
        />
        {unit ? <span className="ml-2 text-xs text-fg-subtle">{unit}</span> : null}
      </span>
      {hint ? <span className="text-[11px] text-fg-subtle">{hint}</span> : null}
    </label>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm text-danger">
      {message}
    </p>
  );
}

export function errorMessage(err: unknown): string | null {
  if (isNextRedirect(err)) return null;
  if (err instanceof Error && err.message) return err.message;
  return "Impossible d'enregistrer. Réessaie.";
}
