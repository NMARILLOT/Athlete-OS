import Link from "next/link";
import { MOVEMENT_PATTERN_VALUES, MUSCLE_GROUP_VALUES } from "@/domain/core";
import { addDays } from "@/domain/core/dates";
import type { ProgressView } from "@/server/services/view-models";
import { Card, CardTitle } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { cn } from "@/lib/cn";
import { formatDateShort, formatKg, formatMinutes, formatPace } from "@/lib/format";
import {
  BarChart,
  LineChart,
  Legend,
  Sparkline,
  StackedBarChart,
  dateTicks,
  dayIndex,
  shortDayMonth,
  type LineSeries,
} from "./charts";
import {
  MUSCLE_LABEL_FR,
  PATTERN_LABEL_FR,
  PR_KIND_LABEL_FR,
  RANGE_LABEL_FR,
  TEST_KEY_LABEL_FR,
} from "./labels";

/**
 * Progress sections (spec §27) — one card each, in the order the page renders them. Every
 * section has a French empty state; estimated values carry "≈"; there is no composite score.
 */

const RANGES = ["7d", "4w", "3m", "6m", "1y", "all"] as const;

export function RangeChips({ active }: { active: string }) {
  return (
    <nav aria-label="Période" className="no-scrollbar -mx-4 overflow-x-auto px-4">
      <ul className="flex gap-2">
        {RANGES.map((r) => {
          const isActive = r === active;
          return (
            <li key={r}>
              <Link
                href={`/progress?range=${r}`}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "inline-flex h-11 items-center rounded-full px-4 text-sm font-semibold whitespace-nowrap transition-colors",
                  isActive ? "bg-accent text-accent-fg" : "bg-bg-muted text-fg-muted hover:text-fg",
                )}
              >
                {RANGE_LABEL_FR[r] ?? r}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function hoursLabel(minutes: number): string {
  if (minutes <= 0) return "0";
  const h = minutes / 60;
  return h >= 10
    ? `${Math.round(h)} h`
    : `${(Math.round(h * 10) / 10).toString().replace(".", ",")} h`;
}

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------

export function VolumeSection({ volume }: { volume: ProgressView["volume"] }) {
  const total = volume.reduce((s, w) => s + w.minutes, 0);
  const weeksWithData = volume.filter((w) => w.minutes > 0).length;
  return (
    <Card>
      <CardTitle>Volume</CardTitle>
      {total === 0 ? (
        <Empty title="Aucune séance terminée sur la période">
          Les heures par semaine apparaîtront dès ta première séance terminée.
        </Empty>
      ) : (
        <>
          <p className="mt-1 text-sm text-fg-muted">
            {formatMinutes(total)} au total ·{" "}
            {formatMinutes(Math.round(total / Math.max(1, weeksWithData)))} par semaine active
          </p>
          <div className="mt-3">
            <BarChart
              ariaLabel="Heures d'entraînement par semaine"
              data={volume.map((w) => ({
                label: shortDayMonth(w.weekStart),
                value: w.minutes,
                title: `Semaine du ${formatDateShort(w.weekStart)} : ${formatMinutes(w.minutes)}`,
              }))}
              format={hoursLabel}
            />
          </div>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Distribution
// ---------------------------------------------------------------------------

const DISTRIBUTION_SERIES = [
  { key: "crossfit", label: "CrossFit", fill: "fill-crossfit", swatch: "bg-crossfit" },
  { key: "strength", label: "Force", fill: "fill-strength", swatch: "bg-strength" },
  {
    key: "easyEndurance",
    label: "Endurance facile",
    fill: "fill-cardio-easy",
    swatch: "bg-cardio-easy",
  },
  {
    key: "hardEndurance",
    label: "Endurance intense",
    fill: "fill-cardio-hard",
    swatch: "bg-cardio-hard",
  },
  { key: "recovery", label: "Récupération", fill: "fill-recovery", swatch: "bg-recovery" },
] as const;

export function DistributionSection({
  distribution,
}: {
  distribution: ProgressView["distribution"];
}) {
  const totals = {
    crossfit: 0,
    strength: 0,
    easyEndurance: 0,
    hardEndurance: 0,
    recovery: 0,
  };
  for (const w of distribution) {
    totals.crossfit += w.crossfit;
    totals.strength += w.strength;
    totals.easyEndurance += w.easyEndurance;
    totals.hardEndurance += w.hardEndurance;
    totals.recovery += w.recovery;
  }
  const grand = Object.values(totals).reduce((s, v) => s + v, 0);
  return (
    <Card>
      <CardTitle>Distribution</CardTitle>
      {grand === 0 ? (
        <Empty title="Rien à répartir pour l'instant">
          CrossFit, force, endurance facile ou intense, récupération : la répartition se construit
          avec tes séances terminées.
        </Empty>
      ) : (
        <>
          <div className="mt-3">
            <StackedBarChart
              ariaLabel="Répartition hebdomadaire par famille de séance"
              data={distribution.map((w) => ({
                label: shortDayMonth(w.weekStart),
                values: {
                  crossfit: w.crossfit,
                  strength: w.strength,
                  easyEndurance: w.easyEndurance,
                  hardEndurance: w.hardEndurance,
                  recovery: w.recovery,
                },
              }))}
              series={[...DISTRIBUTION_SERIES]}
              format={hoursLabel}
            />
          </div>
          <Legend
            items={DISTRIBUTION_SERIES.map((s) => ({
              label: `${s.label} ${Math.round((totals[s.key] / grand) * 100)} %`,
              swatch: s.swatch,
            }))}
          />
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Charge (session-RPE load)
// ---------------------------------------------------------------------------

function formatAu(v: number): string {
  return `${Math.round(v).toLocaleString("fr-FR")}`;
}

export function LoadSection({
  load,
  from,
  to,
}: {
  load: ProgressView["load"];
  from: string;
  to: string;
}) {
  const hasLoad = load.daily.some((d) => d.load > 0);
  const rolling: Array<{ x: number; y: number; title: string }> = [];
  for (let i = 6; i < load.daily.length; i++) {
    const window = load.daily.slice(i - 6, i + 1);
    const sum = window.reduce((s, d) => s + d.load, 0);
    const day = load.daily[i];
    if (day)
      rolling.push({
        x: i,
        y: sum,
        title: `7 j au ${formatDateShort(day.date)} : ${formatAu(sum)} AU`,
      });
  }
  return (
    <Card>
      <CardTitle>Charge</CardTitle>
      {!hasLoad ? (
        <Empty title="Pas encore de charge calculée">
          La charge = durée × RPE. Renseigne le RPE après chaque séance pour la voir apparaître.
        </Empty>
      ) : (
        <>
          <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-bg-muted/60 px-2 py-2">
              <dt className="text-[11px] tracking-wide text-fg-subtle uppercase">7 jours</dt>
              <dd className="text-lg font-semibold tabular-nums">{formatAu(load.acute7d)}</dd>
            </div>
            <div className="rounded-xl bg-bg-muted/60 px-2 py-2">
              <dt className="text-[11px] tracking-wide text-fg-subtle uppercase">
                Moy. hebdo 4 sem
              </dt>
              <dd className="text-lg font-semibold tabular-nums">
                {formatAu(load.chronicWeeklyAvg)}
              </dd>
            </div>
            <div className="rounded-xl bg-bg-muted/60 px-2 py-2">
              <dt className="text-[11px] tracking-wide text-fg-subtle uppercase">Ratio</dt>
              <dd className="text-lg font-semibold tabular-nums">
                {load.ratio != null ? load.ratio.toFixed(2).replace(".", ",") : "—"}
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-xs text-fg-subtle">
            Indicateur de charge (durée × RPE, en unités arbitraires), pas un score de forme ni une
            prédiction de blessure.
            {load.ratio == null ? " Le ratio s'affiche après 3 semaines d'historique." : ""}
          </p>
          <div className="mt-3">
            <BarChart
              ariaLabel="Charge quotidienne (durée × RPE)"
              data={load.daily.map((d) => ({
                label: shortDayMonth(d.date),
                value: d.load,
                title: `${formatDateShort(d.date)} : ${formatAu(d.load)} AU`,
              }))}
              format={formatAu}
              height={130}
            />
          </div>
          {rolling.length > 1 ? (
            <div className="mt-2">
              <LineChart
                ariaLabel="Charge glissante sur 7 jours et moyenne hebdomadaire des 4 dernières semaines"
                series={[
                  {
                    key: "acute",
                    label: "Charge 7 j glissante",
                    stroke: "stroke-accent",
                    fill: "fill-accent",
                    points: rolling,
                  },
                ]}
                hline={
                  load.chronicWeeklyAvg > 0
                    ? {
                        y: load.chronicWeeklyAvg,
                        label: "Moyenne hebdo 4 sem",
                        stroke: "stroke-fg-muted",
                      }
                    : undefined
                }
                xTicks={dateTicks(from, to)}
                xDomain={[0, Math.max(1, load.daily.length - 1)]}
                yFormat={formatAu}
                yFrom0
                height={130}
              />
              <Legend
                items={[
                  { label: "Charge 7 j glissante", swatch: "bg-accent" },
                  { label: "Moyenne hebdo 4 sem (pointillés)", swatch: "bg-fg-muted" },
                ]}
              />
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Force (e1RM per benchmark lift)
// ---------------------------------------------------------------------------

export function StrengthSection({
  strength,
  from,
  to,
}: {
  strength: ProgressView["strength"];
  from: string;
  to: string;
}) {
  return (
    <Card>
      <CardTitle>Force</CardTitle>
      {strength.length === 0 ? (
        <Empty title="Pas encore d'e1RM sur la période">
          Termine une séance de force avec des séries de travail : l&apos;e1RM (estimé, formule
          Epley) apparaîtra par mouvement.
        </Empty>
      ) : (
        <ul className="mt-2 flex flex-col divide-y divide-border">
          {strength.map((lift) => {
            const first = lift.points[0];
            const last = lift.points[lift.points.length - 1];
            const delta =
              first && last && lift.points.length > 1 ? last.e1rmKg - first.e1rmKg : null;
            return (
              <li key={lift.exerciseId} className="py-3 first:pt-1 last:pb-0">
                <div className="flex items-baseline justify-between gap-2">
                  <Link
                    href={`/exercises/${lift.exerciseId}`}
                    className="font-medium text-fg hover:text-accent"
                  >
                    {lift.name}
                  </Link>
                  <span className="text-sm text-fg-muted tabular-nums">
                    {last ? `≈ ${formatKg(last.e1rmKg)}` : "—"}
                    {delta != null ? (
                      <span
                        className={cn("ml-2 text-xs", delta >= 0 ? "text-accent" : "text-warn")}
                      >
                        {delta >= 0 ? "+" : "−"}
                        {formatKg(Math.abs(delta))}
                      </span>
                    ) : null}
                  </span>
                </div>
                <div className="mt-1">
                  <LineChart
                    ariaLabel={`e1RM estimé hebdomadaire — ${lift.name}`}
                    series={[
                      {
                        key: lift.exerciseId,
                        label: `${lift.name} (e1RM estimé)`,
                        stroke: "stroke-strength",
                        fill: "fill-strength",
                        points: lift.points.map((p) => ({
                          x: dayIndex(from, p.date),
                          y: p.e1rmKg,
                          title: `Semaine du ${formatDateShort(p.date)} : ≈ ${formatKg(p.e1rmKg)}`,
                        })),
                      },
                    ]}
                    xTicks={dateTicks(from, to, 3)}
                    xDomain={[0, Math.max(1, dayIndex(from, to))]}
                    yFormat={(v) => `≈ ${Math.round(v)}`}
                    height={96}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {strength.length > 0 ? (
        <p className="mt-2 text-xs text-fg-subtle">
          Meilleur e1RM de chaque semaine, estimé depuis tes séries (Epley). Le « ≈ » rappelle que
          ce n&apos;est pas un 1RM testé.
        </p>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Moteur aérobie
// ---------------------------------------------------------------------------

export function EngineSection({
  engine,
  from,
  to,
}: {
  engine: ProgressView["engine"];
  from: string;
  to: string;
}) {
  const bands = [...new Set(engine.paceAtHr.map((p) => p.hrBand))].sort();
  const opacityFor = (band: string) => {
    const i = bands.indexOf(band);
    return bands.length <= 1 ? 1 : 0.35 + (0.65 * i) / (bands.length - 1);
  };
  const series: LineSeries[] = [];
  if (engine.paceAtHr.length > 0)
    series.push({
      key: "pace",
      label: "Allure sur sorties faciles (mesuré)",
      stroke: "stroke-cardio-easy",
      fill: "fill-cardio-easy",
      scatter: true,
      points: engine.paceAtHr.map((p) => ({
        x: dayIndex(from, p.date),
        y: p.paceSecKm,
        opacity: opacityFor(p.hrBand),
        title: `${formatDateShort(p.date)} : ${formatPace(p.paceSecKm)} à ${p.hrBand} bpm`,
      })),
    });
  if (engine.thresholdPace.length > 0)
    series.push({
      key: "threshold",
      label: "Allure seuil (estimée)",
      stroke: "stroke-cardio-hard",
      fill: "fill-cardio-hard",
      dashed: true,
      points: engine.thresholdPace.map((p) => ({
        x: dayIndex(from, p.date),
        y: p.paceSecKm,
        title: `${formatDateShort(p.date)} : seuil ≈ ${formatPace(p.paceSecKm)}`,
      })),
    });
  const empty = series.length === 0 && engine.tests.length === 0;
  return (
    <Card>
      <CardTitle>Moteur aérobie</CardTitle>
      {empty ? (
        <Empty title="Pas encore de données Garmin">
          Allure à FC, allure seuil et tests apparaîtront après un import FIT ou une synchro Garmin.
        </Empty>
      ) : (
        <>
          {series.length > 0 ? (
            <div className="mt-3">
              <LineChart
                ariaLabel="Allure à fréquence cardiaque sur sorties faciles comparables, et allure seuil estimée"
                series={series}
                xTicks={dateTicks(from, to)}
                xDomain={[0, Math.max(1, dayIndex(from, to))]}
                yFormat={(v) => formatPace(v).replace(" /km", "")}
                yInverted
                height={160}
              />
              <p className="mt-1 text-[11px] text-fg-subtle">min/km — plus haut = plus rapide.</p>
              <Legend
                items={[
                  ...(engine.paceAtHr.length > 0
                    ? bands.map((b) => ({ label: `${b} bpm`, swatch: "bg-cardio-easy" }))
                    : []),
                  ...(engine.thresholdPace.length > 0
                    ? [{ label: "Seuil ≈ (pointillés)", swatch: "bg-cardio-hard" }]
                    : []),
                ]}
              />
              {engine.paceAtHr.length > 0 ? (
                <p className="mt-1 text-[11px] text-fg-subtle">
                  Points plus clairs = FC plus basse. Sorties faciles comparables uniquement.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="mt-2 text-sm text-fg-muted">
              Pas encore de sortie facile comparable avec FC sur la période.
            </p>
          )}
          {engine.tests.length > 0 ? (
            <table className="mt-3 w-full text-sm">
              <caption className="sr-only">Tests standardisés</caption>
              <thead className="text-[11px] tracking-wide text-fg-subtle uppercase">
                <tr>
                  <th scope="col" className="py-1 text-left font-medium">
                    Test
                  </th>
                  <th scope="col" className="py-1 text-left font-medium">
                    Date
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    Résultat
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {engine.tests.map((t) => (
                  <tr key={`${t.testKey}-${t.date}`}>
                    <td className="py-2 text-fg">{TEST_KEY_LABEL_FR[t.testKey] ?? t.testKey}</td>
                    <td className="py-2 text-fg-muted">{formatDateShort(t.date)}</td>
                    <td className="py-2 text-right tabular-nums">
                      {t.value} {t.unit}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mt-3 text-xs text-fg-subtle">Aucun test standardisé sur la période.</p>
          )}
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// CrossFit
// ---------------------------------------------------------------------------

export function CrossfitSection({ crossfit }: { crossfit: ProgressView["crossfit"] }) {
  const empty = crossfit.benchmarks.length === 0 && crossfit.prs.length === 0;
  return (
    <Card>
      <CardTitle>CrossFit</CardTitle>
      {empty ? (
        <Empty title="Pas de benchmark ni de PR sur la période">
          Score un benchmark (Fran, Grace…) ou termine une séance de force : les records
          apparaîtront ici.
        </Empty>
      ) : (
        <>
          {crossfit.benchmarks.length > 0 ? (
            <table className="mt-2 w-full text-sm">
              <caption className="sr-only">Benchmarks</caption>
              <thead className="text-[11px] tracking-wide text-fg-subtle uppercase">
                <tr>
                  <th scope="col" className="py-1 text-left font-medium">
                    Benchmark
                  </th>
                  <th scope="col" className="py-1 text-left font-medium">
                    Date
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    Score
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {crossfit.benchmarks.map((b) => (
                  <tr key={`${b.benchmarkId}-${b.date}`}>
                    <td className="py-2 text-fg">{b.name}</td>
                    <td className="py-2 text-fg-muted">{formatDateShort(b.date)}</td>
                    <td className="py-2 text-right tabular-nums">{b.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mt-2 text-xs text-fg-subtle">Aucun benchmark scoré sur la période.</p>
          )}
          <h3 className="mt-4 text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">
            PR
          </h3>
          {crossfit.prs.length > 0 ? (
            <ul className="mt-1 divide-y divide-border">
              {crossfit.prs.map((pr) => (
                <li
                  key={`${pr.exerciseId}-${pr.date}-${pr.value}`}
                  className="flex items-center justify-between gap-2 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/exercises/${pr.exerciseId}`}
                      className="block truncate font-medium text-fg hover:text-accent"
                    >
                      {pr.name}
                    </Link>
                    <span className="text-xs text-fg-subtle">{formatDateShort(pr.date)}</span>
                  </div>
                  <span className="shrink-0 tabular-nums">
                    {pr.estimated ? "≈ " : ""}
                    {Number.isInteger(pr.value) ? pr.value : pr.value.toFixed(1)} {pr.unit}
                    {pr.estimated ? (
                      <span className="ml-1 text-xs text-fg-subtle">
                        ({PR_KIND_LABEL_FR.e1rm ?? "e1RM"} estimé)
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-fg-subtle">Aucun PR sur la période.</p>
          )}
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Récupération
// ---------------------------------------------------------------------------

const RECOVERY_METRICS = [
  { key: "restingHr", label: "FC repos", unit: "bpm", digits: 0 },
  { key: "hrv", label: "VFC (rMSSD)", unit: "ms", digits: 0 },
  { key: "sleepHours", label: "Sommeil", unit: "h", digits: 1 },
  { key: "bodyBattery", label: "Body Battery", unit: "", digits: 0 },
] as const;

export function RecoverySection({
  recovery,
  from,
}: {
  recovery: ProgressView["recovery"];
  from: string;
}) {
  const any = recovery.some(
    (r) => r.restingHr != null || r.hrv != null || r.sleepHours != null || r.bodyBattery != null,
  );
  return (
    <Card>
      <CardTitle>Récupération</CardTitle>
      {!any ? (
        <Empty title="Pas encore de données Garmin">
          FC de repos, VFC, sommeil et Body Battery arriveront avec la synchro Garmin.
        </Empty>
      ) : (
        <>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {RECOVERY_METRICS.map((m) => {
              const points = recovery
                .filter((r) => r[m.key] != null)
                .map((r) => ({ x: dayIndex(from, r.date), y: r[m.key] as number, date: r.date }));
              const last = points[points.length - 1];
              return (
                <div key={m.key} className="rounded-xl bg-bg-muted/60 px-3 py-2">
                  <div className="text-[11px] font-medium tracking-wide text-fg-subtle uppercase">
                    {m.label}
                  </div>
                  <div className="mt-0.5 flex items-baseline gap-1">
                    <span className="text-xl font-semibold text-fg tabular-nums">
                      {last ? last.y.toFixed(m.digits).replace(".", ",") : "—"}
                    </span>
                    {last && m.unit ? (
                      <span className="text-xs text-fg-muted">{m.unit}</span>
                    ) : null}
                  </div>
                  {points.length > 0 ? (
                    <Sparkline
                      ariaLabel={`${m.label} — ${points.length} mesures, dernière ${last ? formatDateShort(last.date) : ""}`}
                      points={points}
                      stroke="stroke-recovery"
                      fill="fill-recovery"
                    />
                  ) : (
                    <p className="mt-1 text-[11px] text-fg-subtle">Aucune mesure</p>
                  )}
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-fg-subtle">Source : mesuré (Garmin).</p>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Plaisir
// ---------------------------------------------------------------------------

export function EnjoymentSection({
  enjoyment,
  from,
  to,
}: {
  enjoyment: ProgressView["enjoyment"];
  from: string;
  to: string;
}) {
  const fourWeeksAgo = addDays(to, -27);
  const recent = enjoyment.filter((e) => e.date >= fourWeeksAgo);
  const mean4w = recent.length > 0 ? recent.reduce((s, e) => s + e.fun, 0) / recent.length : null;
  return (
    <Card>
      <CardTitle>Plaisir</CardTitle>
      {enjoyment.length === 0 ? (
        <Empty title="Pas encore de ressenti">
          Après chaque séance, dis comment c&apos;était : le score plaisir (1–10) se construit à
          partir de ton ressenti déclaré.
        </Empty>
      ) : (
        <>
          <p className="mt-1 text-sm text-fg-muted">
            Moyenne 4 semaines :{" "}
            <span className="font-semibold text-fg tabular-nums">
              {mean4w != null ? mean4w.toFixed(1).replace(".", ",") : "—"}
            </span>{" "}
            / 10
          </p>
          {mean4w != null && mean4w < 5 ? (
            <p className="mt-1 text-sm text-warn">Le programme semble moins fun ces temps-ci.</p>
          ) : null}
          <div className="mt-3">
            <LineChart
              ariaLabel="Score plaisir par jour (déclaré)"
              series={[
                {
                  key: "fun",
                  label: "Plaisir (déclaré)",
                  stroke: "stroke-accent",
                  fill: "fill-accent",
                  points: enjoyment.map((e) => ({
                    x: dayIndex(from, e.date),
                    y: e.fun,
                    title: `${formatDateShort(e.date)} : ${e.fun.toString().replace(".", ",")} / 10`,
                  })),
                },
              ]}
              xTicks={dateTicks(from, to)}
              xDomain={[0, Math.max(1, dayIndex(from, to))]}
              yFormat={(v) => String(Math.round(v))}
              yFrom0
              height={120}
            />
          </div>
          <p className="mt-1 text-xs text-fg-subtle">
            Ressenti déclaré après séance (trop bien 9 · bien 7 · moyen 4 · trop dur 3).
          </p>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Exposition (this week's heatmap)
// ---------------------------------------------------------------------------

const MAX_BARS = 5;

function ExposureRow({ label, bars, value }: { label: string; bars: number; value: number }) {
  const filled = Math.max(0, Math.min(MAX_BARS, bars));
  return (
    <li className="flex items-center gap-3 py-1.5">
      <span className="w-36 shrink-0 truncate text-sm text-fg">{label}</span>
      <span
        role="img"
        aria-label={`${label} : ${filled} sur ${MAX_BARS}`}
        className="flex flex-1 items-center gap-1"
      >
        {Array.from({ length: MAX_BARS }, (_, i) => (
          <span
            key={i}
            aria-hidden
            className={cn("h-2 flex-1 rounded-sm", i < filled ? "bg-accent" : "bg-bg-muted")}
          />
        ))}
      </span>
      <span className="w-10 text-right text-xs text-fg-subtle tabular-nums">
        {value > 0 ? `≈ ${value.toFixed(1).replace(".", ",")}` : "—"}
      </span>
    </li>
  );
}

export function ExposureSection({ heatmap }: { heatmap: ProgressView["heatmap"] }) {
  const patterns = heatmap.patterns.filter((p) => p.value > 0);
  const muscles = heatmap.muscles.filter((m) => m.value > 0);
  const patternLabel = (key: string) =>
    (MOVEMENT_PATTERN_VALUES as readonly string[]).includes(key)
      ? PATTERN_LABEL_FR[key as (typeof MOVEMENT_PATTERN_VALUES)[number]]
      : key;
  const muscleLabel = (key: string) =>
    (MUSCLE_GROUP_VALUES as readonly string[]).includes(key)
      ? MUSCLE_LABEL_FR[key as (typeof MUSCLE_GROUP_VALUES)[number]]
      : key;
  return (
    <Card>
      <CardTitle>Exposition cette semaine</CardTitle>
      {patterns.length === 0 && muscles.length === 0 ? (
        <Empty title="Aucune exposition enregistrée cette semaine">
          Les schémas de mouvement et les groupes musculaires travaillés se remplissent au fil des
          séances terminées.
        </Empty>
      ) : (
        <>
          <h3 className="mt-2 text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">
            Schémas de mouvement
          </h3>
          {patterns.length > 0 ? (
            <ul className="mt-1 divide-y divide-border">
              {patterns.map((p) => (
                <ExposureRow
                  key={p.key}
                  label={patternLabel(p.key)}
                  bars={p.bars}
                  value={p.value}
                />
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-fg-subtle">Aucun schéma exposé cette semaine.</p>
          )}
          <h3 className="mt-4 text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">
            Groupes musculaires
          </h3>
          {muscles.length > 0 ? (
            <ul className="mt-1 divide-y divide-border">
              {muscles.map((m) => (
                <ExposureRow key={m.key} label={muscleLabel(m.key)} bars={m.bars} value={m.value} />
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-fg-subtle">Aucun groupe exposé cette semaine.</p>
          )}
          <p className="mt-2 text-xs text-fg-subtle">
            Barres relatives à une semaine bien couverte ({MAX_BARS} = référence), estimées depuis
            l&apos;analyse des séances.
          </p>
        </>
      )}
    </Card>
  );
}
