"use client";

import { useId, useMemo, useState, type PointerEvent } from "react";
import type { HrZone, TimeInZones } from "@/domain/cardio";
import type { StreamPoint } from "@/server/services/activity.service";
import { formatDurationSec } from "@/lib/format";

/**
 * Inline-SVG charts for one activity (spec §29): one series per chart, one axis, hairline grid,
 * 2px line, crosshair + tooltip on hover/touch. No chart library (ARCHITECTURE: no new deps).
 */
export type SeriesTone = "hr" | "pace" | "altitude" | "power";

const STROKE: Record<SeriesTone, string> = {
  hr: "stroke-cardio-hard",
  pace: "stroke-accent",
  altitude: "stroke-info",
  power: "stroke-strength",
};
const DOT: Record<SeriesTone, string> = {
  hr: "fill-cardio-hard",
  pace: "fill-accent",
  altitude: "fill-info",
  power: "fill-strength",
};

const W = 360;
const H = 150;
const PAD = { top: 10, right: 12, bottom: 22, left: 40 };

function clock(sec: number): string {
  return formatDurationSec(sec);
}

export function LineChart({
  points,
  label,
  unit,
  tone,
  format = (v) => String(Math.round(v)),
  /** Pace: lower is faster → drawn upwards. */
  invert = false,
}: {
  points: StreamPoint[];
  label: string;
  unit: string;
  tone: SeriesTone;
  format?: (v: number) => string;
  invert?: boolean;
}) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const model = useMemo(() => {
    const valid = points.filter((p): p is { t: number; v: number } => p.v != null);
    if (valid.length < 2) return null;
    const tMax = Math.max(1, points[points.length - 1]?.t ?? 1);
    let vMin = Math.min(...valid.map((p) => p.v));
    let vMax = Math.max(...valid.map((p) => p.v));
    if (vMax === vMin) {
      vMin -= 1;
      vMax += 1;
    }
    const span = vMax - vMin;
    vMin -= span * 0.08;
    vMax += span * 0.08;
    const x = (t: number) => PAD.left + (t / tMax) * (W - PAD.left - PAD.right);
    const y = (v: number) => {
      const r = (v - vMin) / (vMax - vMin);
      const rr = invert ? 1 - r : r;
      return H - PAD.bottom - rr * (H - PAD.top - PAD.bottom);
    };
    // Segments break on nulls: a gap is a gap, never bridged.
    let d = "";
    let open = false;
    for (const p of points) {
      if (p.v == null) {
        open = false;
        continue;
      }
      d += `${open ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
      open = true;
    }
    const ticks = [vMin + (vMax - vMin) * 0.15, (vMin + vMax) / 2, vMin + (vMax - vMin) * 0.85];
    return { d, x, y, tMax, ticks, vMin, vMax };
  }, [points, invert]);

  if (!model)
    return (
      <div className="rounded-xl bg-bg-muted/60 px-3 py-4 text-sm text-fg-muted">
        {label} : pas assez de données.
      </div>
    );
  const tMax = model.tMax;

  function onMove(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const t = ((px - PAD.left) / (W - PAD.left - PAD.right)) * tMax;
    let best = 0;
    let bestDist = Infinity;
    points.forEach((p, i) => {
      const dist = Math.abs(p.t - t);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    setHover(best);
  }

  const hp = hover != null ? points[hover] : undefined;
  const hx = hp ? model.x(hp.t) : null;
  const hy = hp && hp.v != null ? model.y(hp.v) : null;
  const tooltipLeftPct = hx != null ? (hx / W) * 100 : 0;

  return (
    <figure className="relative" aria-labelledby={`${id}-title`}>
      <figcaption id={`${id}-title`} className="mb-1 flex items-baseline justify-between">
        <span className="text-xs font-semibold tracking-wide text-fg-muted uppercase">{label}</span>
        <span className="text-[11px] text-fg-subtle">{unit}</span>
      </figcaption>
      {hp ? (
        <div
          role="status"
          className="pointer-events-none absolute top-6 z-10 -translate-x-1/2 rounded-lg bg-bg-elevated px-2 py-1 text-xs whitespace-nowrap shadow-[var(--shadow-card)] ring-1 ring-border"
          style={{ left: `clamp(56px, ${tooltipLeftPct}%, calc(100% - 56px))` }}
        >
          <span className="text-fg-muted">{clock(hp.t)}</span>{" "}
          <span className="font-semibold tabular-nums">
            {hp.v != null ? `${format(hp.v)} ${unit}` : "—"}
          </span>
        </div>
      ) : null}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full touch-none select-none"
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`${label} au fil du temps`}
      >
        {model.ticks.map((v) => (
          <g key={v}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={model.y(v)}
              y2={model.y(v)}
              className="stroke-border"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={model.y(v) + 3}
              textAnchor="end"
              className="fill-fg-subtle text-[9px] tabular-nums"
            >
              {format(v)}
            </text>
          </g>
        ))}
        {[0, 0.5, 1].map((r) => (
          <text
            key={r}
            x={model.x(model.tMax * r)}
            y={H - 6}
            textAnchor={r === 0 ? "start" : r === 1 ? "end" : "middle"}
            className="fill-fg-subtle text-[9px] tabular-nums"
          >
            {clock(model.tMax * r)}
          </text>
        ))}
        <path
          d={model.d}
          fill="none"
          className={STROKE[tone]}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {hx != null ? (
          <line
            x1={hx}
            x2={hx}
            y1={PAD.top}
            y2={H - PAD.bottom}
            className="stroke-fg-subtle"
            strokeWidth={1}
          />
        ) : null}
        {hx != null && hy != null ? (
          <circle cx={hx} cy={hy} r={4} className={`${DOT[tone]} stroke-bg`} strokeWidth={2} />
        ) : null}
      </svg>
    </figure>
  );
}

const ZONE_BAR: Record<number, string> = {
  1: "bg-recovery",
  2: "bg-cardio-easy",
  3: "bg-warn",
  4: "bg-cardio-hard",
  5: "bg-danger",
};

/** Minutes per HR zone as horizontal bars (≤ 24 px thick, rounded data-end). */
export function ZoneBars({ zones, timeInZones }: { zones: HrZone[]; timeInZones: TimeInZones }) {
  const minutes = [timeInZones.z1, timeInZones.z2, timeInZones.z3, timeInZones.z4, timeInZones.z5];
  const max = Math.max(1, ...minutes);
  const total = minutes.reduce((a, b) => a + b, 0);
  return (
    <ul className="flex flex-col gap-2" aria-label="Temps par zone">
      {zones.map((z, i) => {
        const min = minutes[i] ?? 0;
        const range =
          z.minBpm <= 0
            ? `≤ ${z.maxBpm}`
            : z.maxBpm >= 250
              ? `≥ ${z.minBpm}`
              : `${z.minBpm}–${z.maxBpm}`;
        return (
          <li key={z.zone} className="flex items-center gap-2 text-sm">
            <span className="w-24 shrink-0 text-xs text-fg-muted tabular-nums">
              Z{z.zone} <span className="text-fg-subtle">{range}</span>
            </span>
            <span className="relative h-4 flex-1 overflow-hidden rounded-r">
              <span
                className={`absolute inset-y-0 left-0 rounded-r ${ZONE_BAR[z.zone] ?? "bg-fg-muted"}`}
                style={{ width: `${Math.max(min > 0 ? 2 : 0, (min / max) * 100)}%` }}
              />
            </span>
            <span className="w-16 shrink-0 text-right text-xs tabular-nums">
              {min > 0 ? `${Math.round(min)} min` : "—"}
              {total > 0 && min > 0 ? (
                <span className="text-fg-subtle"> {Math.round((min / total) * 100)}%</span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
