import { addDays, daysBetween } from "@/domain/core/dates";

/**
 * Inline-SVG chart primitives for the Progress and Exercise pages. They render in Server
 * Components (no JS, no chart library): responsive through `viewBox`, colours through the design
 * tokens (`fill-*` / `stroke-*` utilities), one recessive axis, minimal tick labels in text ink,
 * and a native `<title>` on the figure and on every mark so values are readable on hover and by
 * assistive tech. Series colours are passed as literal class names so Tailwind can see them.
 */

export const CHART_W = 320;
const PAD = { top: 8, right: 10, bottom: 18, left: 38 } as const;

/** Round a maximum up to a "nice" tick value (1 / 2 / 2.5 / 5 × 10ⁿ). */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= value) return candidate;
  }
  return 10 * magnitude;
}

function scale(domain: readonly [number, number], range: readonly [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 === 0 ? 1 : d1 - d0;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

/** Bar with 2 px rounded data-ends, anchored to the baseline. */
function barPath(x: number, y: number, w: number, h: number, baseline: number): string {
  if (h <= 0 || w <= 0) return "";
  const r = Math.min(2, w / 2, h);
  const top = baseline - h;
  return [
    `M${x} ${baseline}`,
    `L${x} ${top + r}`,
    `Q${x} ${top} ${x + r} ${top}`,
    `L${x + w - r} ${top}`,
    `Q${x + w} ${top} ${x + w} ${top + r}`,
    `L${x + w} ${baseline}`,
    "Z",
  ].join(" ");
}

function Axis({
  ticks,
  x0,
  x1,
  format,
}: {
  ticks: Array<{ y: number; value: number }>;
  x0: number;
  x1: number;
  format: (v: number) => string;
}) {
  return (
    <g aria-hidden>
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={x0} x2={x1} y1={t.y} y2={t.y} className="stroke-border" strokeWidth={1} />
          <text
            x={x0 - 6}
            y={t.y}
            textAnchor="end"
            dominantBaseline="middle"
            className="fill-fg-subtle text-[9px] tabular-nums"
          >
            {format(t.value)}
          </text>
        </g>
      ))}
    </g>
  );
}

/** Keep at most `max` evenly spaced labels along the x axis. */
function pickLabelIndexes(count: number, max = 6): Set<number> {
  if (count <= max) return new Set(Array.from({ length: count }, (_, i) => i));
  const step = Math.ceil(count / max);
  const out = new Set<number>();
  for (let i = 0; i < count; i += step) out.add(i);
  out.add(count - 1);
  return out;
}

// ---------------------------------------------------------------------------
// BarChart
// ---------------------------------------------------------------------------

export interface BarDatum {
  label: string;
  value: number;
  /** Hover / screen-reader text; defaults to `label: value`. */
  title?: string;
}

export function BarChart({
  data,
  ariaLabel,
  format = (v) => String(Math.round(v)),
  fill = "fill-accent",
  height = 150,
  yMax,
}: {
  data: BarDatum[];
  ariaLabel: string;
  format?: (v: number) => string;
  /** Literal Tailwind class, e.g. `fill-accent`. */
  fill?: string;
  height?: number;
  yMax?: number;
}) {
  const x0 = PAD.left;
  const x1 = CHART_W - PAD.right;
  const baseline = height - PAD.bottom;
  const top = niceMax(yMax ?? Math.max(0, ...data.map((d) => d.value)));
  const y = scale([0, top], [baseline, PAD.top]);
  const slot = data.length ? (x1 - x0) / data.length : 0;
  const gap = Math.min(4, slot * 0.25);
  const w = Math.max(2, slot - gap);
  const labels = pickLabelIndexes(data.length);
  return (
    <svg viewBox={`0 0 ${CHART_W} ${height}`} className="h-auto w-full" role="img">
      <title>{ariaLabel}</title>
      <Axis
        ticks={[0, top / 2, top].map((v) => ({ value: v, y: y(v) }))}
        x0={x0}
        x1={x1}
        format={format}
      />
      {data.map((d, i) => {
        const x = x0 + i * slot + gap / 2;
        const h = Math.max(0, baseline - y(Math.max(0, d.value)));
        return (
          <g key={`${d.label}-${i}`}>
            <title>{d.title ?? `${d.label} : ${format(d.value)}`}</title>
            <rect x={x} y={PAD.top} width={w} height={baseline - PAD.top} fill="transparent" />
            {h > 0 ? <path d={barPath(x, 0, w, h, baseline)} className={fill} /> : null}
            {labels.has(i) ? (
              <text
                x={x + w / 2}
                y={height - 5}
                textAnchor="middle"
                className="fill-fg-subtle text-[9px] tabular-nums"
              >
                {d.label}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// StackedBarChart
// ---------------------------------------------------------------------------

export interface StackedSeries {
  key: string;
  label: string;
  /** Literal Tailwind class, e.g. `fill-crossfit`. */
  fill: string;
  /** Literal Tailwind class for the legend swatch, e.g. `bg-crossfit`. */
  swatch: string;
}

export interface StackedDatum {
  label: string;
  values: Record<string, number>;
}

export function StackedBarChart({
  data,
  series,
  ariaLabel,
  format = (v) => String(Math.round(v)),
  height = 160,
}: {
  data: StackedDatum[];
  series: StackedSeries[];
  ariaLabel: string;
  format?: (v: number) => string;
  height?: number;
}) {
  const x0 = PAD.left;
  const x1 = CHART_W - PAD.right;
  const baseline = height - PAD.bottom;
  const totals = data.map((d) => series.reduce((s, k) => s + Math.max(0, d.values[k.key] ?? 0), 0));
  const top = niceMax(Math.max(0, ...totals));
  const y = scale([0, top], [baseline, PAD.top]);
  const slot = data.length ? (x1 - x0) / data.length : 0;
  const gap = Math.min(4, slot * 0.25);
  const w = Math.max(2, slot - gap);
  const labels = pickLabelIndexes(data.length);
  return (
    <svg viewBox={`0 0 ${CHART_W} ${height}`} className="h-auto w-full" role="img">
      <title>{ariaLabel}</title>
      <Axis
        ticks={[0, top / 2, top].map((v) => ({ value: v, y: y(v) }))}
        x0={x0}
        x1={x1}
        format={format}
      />
      {data.map((d, i) => {
        const x = x0 + i * slot + gap / 2;
        let acc = 0;
        const parts = series.map((s) => {
          const v = Math.max(0, d.values[s.key] ?? 0);
          const yBottom = y(acc);
          const yTop = y(acc + v);
          acc += v;
          return { s, v, yBottom, yTop };
        });
        const summary = parts
          .filter((p) => p.v > 0)
          .map((p) => `${p.s.label} ${format(p.v)}`)
          .join(" · ");
        return (
          <g key={`${d.label}-${i}`}>
            <title>{`${d.label} : ${format(totals[i] ?? 0)}${summary ? ` — ${summary}` : ""}`}</title>
            <rect x={x} y={PAD.top} width={w} height={baseline - PAD.top} fill="transparent" />
            {parts.map((p) => {
              if (p.v <= 0) return null;
              // 2 px surface gap between stacked segments (kept ≥ 1 px tall so tiny values show).
              const h = Math.max(1, p.yBottom - p.yTop - 2);
              return (
                <rect
                  key={p.s.key}
                  x={x}
                  y={p.yBottom - h - 1}
                  width={w}
                  height={h}
                  rx={1}
                  className={p.s.fill}
                />
              );
            })}
            {labels.has(i) ? (
              <text
                x={x + w / 2}
                y={height - 5}
                textAnchor="middle"
                className="fill-fg-subtle text-[9px] tabular-nums"
              >
                {d.label}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/** Legend for multi-series charts (identity is never colour alone: swatch + text label). */
export function Legend({ items }: { items: Array<{ label: string; swatch: string }> }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-muted">
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5">
          <span aria-hidden className={`inline-block size-2.5 rounded-sm ${it.swatch}`} />
          {it.label}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// LineChart
// ---------------------------------------------------------------------------

export interface LinePoint {
  x: number;
  y: number;
  /** Hover / screen-reader text. */
  title?: string;
  /** Per-point opacity (0..1) for ordered magnitude encodings such as HR bands. */
  opacity?: number;
}

export interface LineSeries {
  key: string;
  label: string;
  /** Literal Tailwind classes, e.g. `stroke-strength` / `fill-strength`. */
  stroke: string;
  fill: string;
  points: LinePoint[];
  dashed?: boolean;
  /** Dots only, no connecting line (scatter). */
  scatter?: boolean;
}

export interface XTick {
  x: number;
  label: string;
}

export function LineChart({
  series,
  ariaLabel,
  xTicks = [],
  xDomain,
  yFormat = (v) => String(Math.round(v)),
  yFrom0 = false,
  yInverted = false,
  hline,
  height = 150,
}: {
  series: LineSeries[];
  ariaLabel: string;
  xTicks?: XTick[];
  xDomain?: readonly [number, number];
  yFormat?: (v: number) => string;
  /** Anchor the y axis at zero (bars-like readings); otherwise pad around the data. */
  yFrom0?: boolean;
  /** Lower values drawn higher (paces: faster on top). */
  yInverted?: boolean;
  /** Horizontal reference line (e.g. a 4-week average). */
  hline?: { y: number; label: string; stroke: string };
  height?: number;
}) {
  const x0 = PAD.left;
  const x1 = CHART_W - PAD.right;
  const baseline = height - PAD.bottom;
  const all = series.flatMap((s) => s.points);
  if (all.length === 0)
    return (
      <svg viewBox={`0 0 ${CHART_W} ${height}`} className="h-auto w-full" role="img">
        <title>{`${ariaLabel} — aucune donnée`}</title>
      </svg>
    );
  const ys = all.map((p) => p.y).concat(hline ? [hline.y] : []);
  const xs = all.map((p) => p.x);
  const [dx0, dx1] = xDomain ?? [Math.min(...xs), Math.max(...xs)];
  const xd: [number, number] = dx0 === dx1 ? [dx0 - 1, dx1 + 1] : [dx0, dx1];
  let yMin = ys.length ? Math.min(...ys) : 0;
  let yMax = ys.length ? Math.max(...ys) : 1;
  if (yFrom0) {
    yMin = 0;
    yMax = niceMax(yMax);
  } else {
    const pad = (yMax - yMin) * 0.15 || Math.abs(yMax) * 0.1 || 1;
    yMin -= pad;
    yMax += pad;
  }
  const x = scale(xd, [x0, x1]);
  const y = scale([yMin, yMax], yInverted ? [PAD.top, baseline] : [baseline, PAD.top]);
  const ticks = [yMin, (yMin + yMax) / 2, yMax];
  return (
    <svg viewBox={`0 0 ${CHART_W} ${height}`} className="h-auto w-full" role="img">
      <title>{ariaLabel}</title>
      <Axis ticks={ticks.map((v) => ({ value: v, y: y(v) }))} x0={x0} x1={x1} format={yFormat} />
      {xTicks.map((t) => (
        <text
          key={`${t.x}-${t.label}`}
          x={x(t.x)}
          y={height - 5}
          textAnchor="middle"
          className="fill-fg-subtle text-[9px] tabular-nums"
          aria-hidden
        >
          {t.label}
        </text>
      ))}
      {hline ? (
        <g>
          <title>{`${hline.label} : ${yFormat(hline.y)}`}</title>
          <line
            x1={x0}
            x2={x1}
            y1={y(hline.y)}
            y2={y(hline.y)}
            strokeWidth={1.5}
            strokeDasharray="3 3"
            className={hline.stroke}
          />
        </g>
      ) : null}
      {series.map((s) => {
        const sorted = [...s.points].sort((a, b) => a.x - b.x);
        const d = sorted.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.x)} ${y(p.y)}`).join(" ");
        return (
          <g key={s.key}>
            <title>{s.label}</title>
            {!s.scatter && sorted.length > 1 ? (
              <path
                d={d}
                fill="none"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={s.dashed ? "4 3" : undefined}
                className={s.stroke}
              />
            ) : null}
            {sorted.map((p, i) => (
              <g key={`${p.x}-${i}`}>
                <title>{p.title ?? `${s.label} : ${yFormat(p.y)}`}</title>
                <circle
                  cx={x(p.x)}
                  cy={y(p.y)}
                  r={s.scatter || sorted.length <= 12 ? 4 : 2.5}
                  className={`${s.fill} stroke-bg-elevated`}
                  strokeWidth={2}
                  fillOpacity={p.opacity ?? 1}
                />
              </g>
            ))}
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------

export function Sparkline({
  points,
  ariaLabel,
  stroke = "stroke-accent",
  fill = "fill-accent",
  width = 120,
  height = 32,
}: {
  points: Array<{ x: number; y: number }>;
  ariaLabel: string;
  stroke?: string;
  fill?: string;
  width?: number;
  height?: number;
}) {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  if (sorted.length === 0) return null;
  const xs = sorted.map((p) => p.x);
  const ys = sorted.map((p) => p.y);
  const xd: [number, number] =
    xs.length === 1 || Math.min(...xs) === Math.max(...xs)
      ? [(xs[0] ?? 0) - 1, (xs[0] ?? 0) + 1]
      : [Math.min(...xs), Math.max(...xs)];
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const pad = (yMax - yMin) * 0.2 || 1;
  const x = scale(xd, [4, width - 4]);
  const y = scale([yMin - pad, yMax + pad], [height - 4, 4]);
  const d = sorted.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.x)} ${y(p.y)}`).join(" ");
  const last = sorted[sorted.length - 1];
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-8 w-full" role="img">
      <title>{ariaLabel}</title>
      {sorted.length > 1 ? (
        <path
          d={d}
          fill="none"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className={stroke}
        />
      ) : null}
      {last ? <circle cx={x(last.x)} cy={y(last.y)} r={3} className={fill} /> : null}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Helpers shared by the sections
// ---------------------------------------------------------------------------

/** Day index of an ISO date relative to the range start (x coordinate of date-based charts). */
export function dayIndex(from: string, date: string): number {
  return daysBetween(from, date);
}

/** "22/9" from an ISO date (compact x-axis label). */
export function shortDayMonth(isoDate: string): string {
  const [, m, d] = isoDate.split("-");
  return `${Number(d)}/${Number(m)}`;
}

/** Up to `n` evenly spaced date ticks between two ISO dates. */
export function dateTicks(from: string, to: string, n = 4): XTick[] {
  const span = daysBetween(from, to);
  if (span <= 0) return [{ x: 0, label: shortDayMonth(from) }];
  const count = Math.min(n, span + 1);
  const out: XTick[] = [];
  for (let i = 0; i < count; i++) {
    const day = Math.round((span * i) / (count - 1 || 1));
    out.push({ x: day, label: shortDayMonth(addDays(from, day)) });
  }
  return out;
}
