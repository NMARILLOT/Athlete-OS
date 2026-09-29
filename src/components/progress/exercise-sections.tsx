import Link from "next/link";
import type { ExercisePrFlags } from "@/server/services/exercise.service";
import type { ExercisePageView, StrengthSetView } from "@/server/services/view-models";
import { Card, CardTitle } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { Stat } from "@/components/ui/stat";
import { formatDateShort, formatKg } from "@/lib/format";
import { LineChart } from "./charts";

/**
 * Exercise page blocks (spec §28). e1RM values are estimates (Epley) and are rendered with "≈";
 * PR values keep what `personal_records` stored, and a record whose `estimated` flag is set (an
 * e1RM-based PR) is rendered with "≈" too — never as a measured lift (spec §70).
 */

function kg(v: number | null): string | null {
  return v == null ? null : Number.isInteger(v) ? String(v) : v.toFixed(1);
}

export function ExerciseStats({ view }: { view: ExercisePageView & Partial<ExercisePrFlags> }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <Stat
        label="e1RM actuel"
        value={kg(view.currentE1rmKg)}
        unit="kg"
        estimated
        hint="28 derniers jours"
      />
      <Stat
        label="PR récent"
        value={kg(view.recentPrKg)}
        unit="kg"
        estimated={view.recentPrEstimated === true}
        hint={view.recentPrEstimated ? "e1RM estimé" : undefined}
      />
      <Stat
        label="Meilleur PR"
        value={kg(view.bestPrKg)}
        unit="kg"
        estimated={view.bestPrEstimated === true}
        hint={view.bestPrEstimated ? "e1RM estimé" : undefined}
      />
      <Stat
        label="Dernière expo"
        value={view.lastExposure ? formatDateShort(view.lastExposure) : null}
      />
      <Stat
        label="Séries / semaine"
        value={view.weeklySets}
        hint="séries de travail, semaine en cours"
      />
    </div>
  );
}

type LoadPoint = ExercisePageView["recentLoads"][number] & { i: number };

export function RecentLoadsChart({ loads }: { loads: ExercisePageView["recentLoads"] }) {
  const withE1rm = loads
    .map((l, i): LoadPoint => ({ ...l, i }))
    .filter((l): l is LoadPoint & { e1rmKg: number } => l.e1rmKg != null);
  if (withE1rm.length === 0)
    return (
      <Card>
        <CardTitle>Charges récentes</CardTitle>
        <Empty title="Pas encore de série de travail">
          Les 20 dernières séries et leur e1RM estimé apparaîtront ici.
        </Empty>
      </Card>
    );
  const first = withE1rm[0];
  const last = withE1rm[withE1rm.length - 1];
  const ticks = [
    ...(first ? [{ x: first.i, label: formatDateShort(first.date) }] : []),
    ...(last && first && last.i !== first.i
      ? [{ x: last.i, label: formatDateShort(last.date) }]
      : []),
  ];
  return (
    <Card>
      <CardTitle>Charges récentes</CardTitle>
      <p className="mt-1 text-sm text-fg-muted">
        e1RM estimé de chaque série de travail, {loads.length} dernières séries.
      </p>
      <div className="mt-3">
        <LineChart
          ariaLabel="e1RM estimé par série, des plus anciennes aux plus récentes"
          series={[
            {
              key: "e1rm",
              label: "e1RM estimé",
              stroke: "stroke-strength",
              fill: "fill-strength",
              points: withE1rm.map((l) => ({
                x: l.i,
                y: l.e1rmKg,
                title: `${formatDateShort(l.date)} : ${l.reps} × ${formatKg(l.weightKg)} → ≈ ${formatKg(l.e1rmKg)}`,
              })),
            },
          ]}
          xTicks={ticks}
          xDomain={[0, Math.max(1, loads.length - 1)]}
          yFormat={(v) => `≈ ${Math.round(v)}`}
          height={140}
        />
      </div>
    </Card>
  );
}

function setLine(s: StrengthSetView): string {
  const reps = s.reps ?? "—";
  const weight = s.weightKg != null ? formatKg(s.weightKg) : "—";
  const rpe = s.rpe != null ? ` @${Number.isInteger(s.rpe) ? s.rpe : s.rpe.toFixed(1)}` : "";
  return `${reps} × ${weight}${rpe}`;
}

export function ExerciseHistory({ history }: { history: ExercisePageView["history"] }) {
  return (
    <Card>
      <CardTitle>Historique</CardTitle>
      {history.length === 0 ? (
        <Empty title="Aucune séance avec ce mouvement">
          L&apos;historique des séries se remplit à chaque séance terminée.
        </Empty>
      ) : (
        <ul className="mt-2 divide-y divide-border">
          {history.map((h) => {
            const working = h.sets.filter((s) => !s.isWarmup);
            const best = working.reduce<number | null>(
              (m, s) => (s.e1rmKg != null && (m === null || s.e1rmKg > m) ? s.e1rmKg : m),
              null,
            );
            return (
              <li key={h.workoutId} className="py-3 first:pt-1 last:pb-0">
                <div className="flex items-baseline justify-between gap-2">
                  <Link
                    href={`/workouts/${h.workoutId}`}
                    className="font-medium text-fg hover:text-accent"
                  >
                    {formatDateShort(h.date)}
                  </Link>
                  <span className="text-xs text-fg-subtle tabular-nums">
                    {working.length} série{working.length > 1 ? "s" : ""}
                    {best != null ? ` · ≈ ${formatKg(best)}` : ""}
                  </span>
                </div>
                <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm tabular-nums">
                  {h.sets.map((s) => (
                    <li key={s.id} className={s.isWarmup ? "text-fg-subtle" : "text-fg-muted"}>
                      {setLine(s)}
                      {s.isWarmup ? " (éch.)" : ""}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
