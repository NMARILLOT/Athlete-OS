import { LOAD_DIMENSION_VALUES, type LoadVector } from "@/domain/core";
import { DIMENSION_LABEL_FR } from "@/domain/engine";

const ROW = 22;
const LABEL_W = 92;
const VALUE_W = 40;
const WIDTH = 320;
const BAR_H = 8;

/**
 * Six-dimension expected-load bars (0..10 each), inline SVG so it renders in RSC and in the
 * builder's live preview alike. One hue (the accent), thin rounded marks on a recessive track,
 * a direct value per row — the values are model outputs, hence the "≈".
 */
export function LoadBars({ vector }: { vector: LoadVector }) {
  const barW = WIDTH - LABEL_W - VALUE_W;
  const height = ROW * LOAD_DIMENSION_VALUES.length;
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${height}`}
      className="w-full"
      role="img"
      aria-label="Charge attendue par dimension, sur 10"
    >
      {LOAD_DIMENSION_VALUES.map((key, i) => {
        const raw = vector[key];
        const v = Number.isFinite(raw) ? Math.max(0, Math.min(10, raw)) : 0;
        const y = i * ROW;
        const barY = y + (ROW - BAR_H) / 2;
        return (
          <g key={key} transform={`translate(0 ${y})`}>
            <title>{`${DIMENSION_LABEL_FR[key]} ≈ ${v.toFixed(1)} / 10`}</title>
            <text x={0} y={ROW / 2} dominantBaseline="middle" className="fill-fg-muted text-[11px]">
              {DIMENSION_LABEL_FR[key]}
            </text>
            <rect
              x={LABEL_W}
              y={barY - y}
              width={barW}
              height={BAR_H}
              rx={4}
              className="fill-bg-muted"
            />
            {v > 0 ? (
              <rect
                x={LABEL_W}
                y={barY - y}
                width={Math.max(BAR_H, (barW * v) / 10)}
                height={BAR_H}
                rx={4}
                className="fill-accent"
              />
            ) : null}
            <text
              x={WIDTH}
              y={ROW / 2}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-fg text-[11px] font-semibold tabular-nums"
            >
              {`≈ ${v.toFixed(1)}`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
