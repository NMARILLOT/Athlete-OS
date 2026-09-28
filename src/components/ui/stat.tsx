import { cn } from "@/lib/cn";

/** Compact metric tile. `estimated` renders the "≈" marker (spec §70: estimated ≠ measured). */
export function Stat({
  label,
  value,
  unit,
  estimated,
  hint,
  className,
}: {
  label: string;
  value: string | number | null | undefined;
  unit?: string;
  estimated?: boolean;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={cn("rounded-xl bg-bg-muted/60 px-3 py-2", className)}>
      <div className="text-[11px] font-medium tracking-wide text-fg-subtle uppercase">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className="text-xl font-semibold text-fg tabular-nums">
          {estimated && value != null ? "≈ " : ""}
          {value ?? "—"}
        </span>
        {unit && value != null ? <span className="text-xs text-fg-muted">{unit}</span> : null}
      </div>
      {hint ? <div className="mt-0.5 text-[11px] text-fg-subtle">{hint}</div> : null}
    </div>
  );
}
