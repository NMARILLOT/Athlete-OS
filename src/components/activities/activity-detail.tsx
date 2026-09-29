import Link from "next/link";
import { Card, CardTitle } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { Stat } from "@/components/ui/stat";
import { formatDateShort, formatDurationSec, formatKm, formatPace } from "@/lib/format";
import type {
  ActivityDetailView,
  ActivityLapView,
  ActivityMetricView,
  ActivityRunningDynamicsView,
} from "@/server/services/activity.service";
import { MODALITY_EMOJI, PROVIDER_FR, describeComparableGroup } from "./labels";

type ActivityHead = ActivityDetailView["activity"];

function localClock(startAt: string, utcOffsetMin: number | null): string {
  const ms = Date.parse(startAt) + (utcOffsetMin ?? 0) * 60_000;
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** Pace in the unit that makes sense for the modality (never a pace for a bike ride). */
function speedStat(a: Pick<ActivityHead, "modality" | "avgPaceSecKm">) {
  const pace = a.avgPaceSecKm;
  switch (a.modality) {
    case "running":
    case "walking":
      return { label: "Allure moy.", value: pace != null ? formatPace(pace) : null, unit: "" };
    case "row":
    case "ski":
      return {
        label: "Allure moy.",
        value: pace != null ? formatPace(pace / 2).replace("/km", "/500 m") : null,
        unit: "",
      };
    case "bike":
      return {
        label: "Vitesse moy.",
        value: pace != null && pace > 0 ? (3600 / pace).toFixed(1) : null,
        unit: "km/h",
      };
    case "swimming":
      return {
        label: "Allure moy.",
        value: pace != null ? formatPace(pace / 10).replace("/km", "/100 m") : null,
        unit: "",
      };
    default:
      return { label: "Allure moy.", value: pace != null ? formatPace(pace) : null, unit: "" };
  }
}

export function ActivityHeader({ a }: { a: ActivityHead }) {
  return (
    <div className="flex items-start gap-3">
      <span aria-hidden className="text-3xl leading-none">
        {MODALITY_EMOJI[a.modality]}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-fg-muted">
          {formatDateShort(a.localDate)} · {localClock(a.startAt, a.utcOffsetMin)}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Chip tone="neutral">{PROVIDER_FR[a.provider] ?? a.provider}</Chip>
          {a.comparableGroup ? (
            <Chip tone="info">{describeComparableGroup(a.comparableGroup)}</Chip>
          ) : null}
          {a.workoutId ? <Chip tone="accent">liée à une séance</Chip> : null}
        </div>
      </div>
    </div>
  );
}

export function ActivitySummary({ a }: { a: ActivityHead }) {
  const speed = speedStat(a);
  return (
    <Card>
      <CardTitle>Résumé</CardTitle>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <Stat label="Durée" value={formatDurationSec(a.durationSec)} />
        <Stat label="Distance" value={a.distanceM != null ? formatKm(a.distanceM) : null} />
        <Stat label={speed.label} value={speed.value} unit={speed.unit || undefined} />
        <Stat label="FC moy." value={a.avgHr} unit="bpm" />
        <Stat label="FC max" value={a.maxHr} unit="bpm" />
        <Stat
          label="D+"
          value={a.elevationGainM != null ? Math.round(a.elevationGainM) : null}
          unit="m"
        />
        <Stat
          label="Puissance"
          value={a.avgPowerW != null ? Math.round(a.avgPowerW) : null}
          unit="W"
        />
        <Stat
          label="Cadence"
          value={a.avgCadence != null ? Math.round(a.avgCadence) : null}
          unit={a.modality === "bike" ? "rpm" : "spm"}
        />
        <Stat
          label="Température"
          value={a.temperatureC != null ? Math.round(a.temperatureC) : null}
          unit="°C"
        />
      </div>
      <p className="mt-2 text-[11px] text-fg-subtle">
        Valeurs mesurées par l&apos;appareil
        {a.deviceSerial ? ` (n° ${a.deviceSerial})` : ""} · lecteur {a.parserVersion}
        {a.calories != null ? ` · ${a.calories} kcal` : ""}
      </p>
    </Card>
  );
}

export function LapsTable({ laps, modality }: { laps: ActivityLapView[]; modality: string }) {
  if (laps.length === 0) return null;
  const paceLabel = modality === "row" || modality === "ski" ? "/500 m" : "Allure";
  const pace = (p: number | null) =>
    p == null
      ? "—"
      : modality === "row" || modality === "ski"
        ? formatPace(p / 2).replace(" /km", "")
        : modality === "bike"
          ? `${(3600 / p).toFixed(1)} km/h`
          : formatPace(p).replace(" /km", "");
  return (
    <Card>
      <CardTitle>Laps</CardTitle>
      <div className="-mx-2 mt-2 overflow-x-auto">
        <table className="w-full min-w-[320px] text-sm tabular-nums">
          <thead className="text-[11px] text-fg-subtle uppercase">
            <tr>
              <th scope="col" className="px-2 py-1 text-left font-medium">
                #
              </th>
              <th scope="col" className="px-2 py-1 text-right font-medium">
                Temps
              </th>
              <th scope="col" className="px-2 py-1 text-right font-medium">
                Dist.
              </th>
              <th scope="col" className="px-2 py-1 text-right font-medium">
                {paceLabel}
              </th>
              <th scope="col" className="px-2 py-1 text-right font-medium">
                FC
              </th>
            </tr>
          </thead>
          <tbody>
            {laps.map((l) => (
              <tr key={l.lapIndex} className="border-t border-border">
                <td className="px-2 py-1.5 text-fg-muted">{l.lapIndex + 1}</td>
                <td className="px-2 py-1.5 text-right">{formatDurationSec(l.durationSec)}</td>
                <td className="px-2 py-1.5 text-right">
                  {l.distanceM != null ? formatKm(l.distanceM) : "—"}
                </td>
                <td className="px-2 py-1.5 text-right">{pace(l.avgPaceSecKm)}</td>
                <td className="px-2 py-1.5 text-right">{l.avgHr ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function MetricsList({ metrics }: { metrics: ActivityMetricView[] }) {
  return (
    <Card>
      <CardTitle>Métriques calculées</CardTitle>
      {metrics.length === 0 ? (
        <p className="mt-2 text-sm text-fg-muted">
          Rien à calculer ici : il faut la FC et la vitesse (ou la puissance), et au moins 40 min
          d&apos;effort après échauffement pour le découplage.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col divide-y divide-border">
          {metrics.map((m) => (
            <li key={m.key} className="flex items-baseline justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">{m.label}</p>
                {m.detail ? <p className="text-xs text-fg-muted">{m.detail}</p> : null}
                <p className="font-mono text-[10px] text-fg-subtle">{m.algorithmVersion}</p>
              </div>
              <p className="shrink-0 text-lg font-semibold tabular-nums">
                {m.estimated ? "≈ " : ""}
                {Number.isInteger(m.value) ? m.value : m.value.toFixed(2)}
                <span className="ml-1 text-xs text-fg-muted">{m.unit}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function DynamicsBlock({ rd }: { rd: ActivityRunningDynamicsView }) {
  return (
    <Card>
      <CardTitle>Dynamique de course</CardTitle>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <Stat
          label="Foulée"
          value={rd.avgStrideLengthM != null ? rd.avgStrideLengthM.toFixed(2) : null}
          unit="m"
        />
        <Stat
          label="Contact sol"
          value={rd.avgGctMs != null ? Math.round(rd.avgGctMs) : null}
          unit="ms"
        />
        <Stat
          label="Oscillation"
          value={
            rd.avgVerticalOscillationMm != null ? rd.avgVerticalOscillationMm.toFixed(1) : null
          }
          unit="mm"
        />
        <Stat
          label="Ratio vertical"
          value={rd.avgVerticalRatio != null ? rd.avgVerticalRatio.toFixed(1) : null}
          unit="%"
        />
        <Stat
          label="Équilibre"
          value={rd.gctBalance != null ? rd.gctBalance.toFixed(1) : null}
          unit="%"
        />
      </div>
      <p className="mt-2 text-[11px] text-fg-subtle">Mesuré par le capteur (HRM-Pro).</p>
    </Card>
  );
}

export function WorkoutLink({ workout }: { workout: ActivityDetailView["workout"] }) {
  if (!workout) return null;
  return (
    <Card>
      <CardTitle>Séance liée</CardTitle>
      <p className="mt-2 font-semibold">{workout.title}</p>
      <p className="text-sm text-fg-muted">
        {workout.rpe != null
          ? `RPE ${workout.rpe}`
          : "Pas encore de RPE : la charge reste en attente."}
      </p>
      <div className="mt-3 flex flex-col gap-2">
        {workout.rpe == null ? (
          <Link
            href={`/workouts/${workout.id}`}
            className="inline-flex h-12 items-center justify-center rounded-xl bg-accent px-4 font-semibold text-accent-fg"
          >
            Donner un RPE
          </Link>
        ) : null}
        <Link
          href={`/workouts/${workout.id}`}
          className="inline-flex h-12 items-center justify-center rounded-xl bg-bg-muted px-4 font-semibold"
        >
          Voir la séance
        </Link>
      </div>
    </Card>
  );
}
