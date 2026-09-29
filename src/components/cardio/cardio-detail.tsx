import Link from "next/link";
import { Card, CardTitle } from "@/components/ui/card";
import { Chip, toneFor } from "@/components/ui/chip";
import { Stat } from "@/components/ui/stat";
import { emptyLoadVector, type Feeling, type LoadVector } from "@/domain/core";
import { clockFromMinutes, formatDateShort } from "@/lib/format";
import { cn } from "@/lib/cn";
import type {
  CardioLoadView,
  CardioStepView,
  CardioWorkoutView,
} from "@/server/services/cardio.service";
import { STATUS_FR } from "./labels";
import { LoadBars } from "./load-bars";

/** Server-rendered blocks of `/train/cardio/[id]` (plain view data in, no client state). */

const FEELING_FR: Record<Feeling, string> = {
  great: "😍 Trop bien",
  good: "🙂 Bien",
  meh: "😐 Moyen",
  too_hard: "😵 Trop dur",
};

const METHOD_FR: Record<string, string> = {
  lthr: "LTHR",
  test: "test",
  hrr: "réserve FC",
  garmin: "Garmin",
  manual: "manuel",
};

export function CardioSummary({ view }: { view: CardioWorkoutView }) {
  const load = view.expectedLoad;
  const zones = view.zoneSet;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone="neutral">{view.modalityLabel}</Chip>
        <Chip tone={toneFor("cardio", load.intensity)}>
          {view.kindLabel} · {load.intensityLabel}
        </Chip>
        {view.fixed ? <Chip tone="warn">fixé</Chip> : null}
        <Chip
          tone={
            view.status === "done"
              ? "accent"
              : view.status === "in_progress"
                ? "info"
                : view.status === "skipped"
                  ? "danger"
                  : "neutral"
          }
        >
          {STATUS_FR[view.status]}
        </Chip>
        {view.garmin.status === "synced" ? <Chip tone="info">Garmin ✓</Chip> : null}
      </div>
      <p className="text-sm text-fg-muted">
        {formatDateShort(view.date)}
        {view.startMinute != null ? ` · ${clockFromMinutes(view.startMinute)}` : ""}
      </p>
      <div className="grid grid-cols-3 gap-2">
        <Stat
          label="Durée"
          value={view.estimatedMin > 0 ? Math.round(view.estimatedMin) : null}
          unit="min"
          estimated
          hint={view.estimatedMin > 0 ? undefined : "au bouton lap"}
        />
        <Stat label="Étapes" value={view.flatSteps.length} />
        <Stat
          label="Zones FC"
          value={zones ? (zones.lthr != null ? `${zones.lthr}` : METHOD_FR[zones.method]) : null}
          unit={zones?.lthr != null ? "bpm" : undefined}
          hint={
            zones
              ? `${METHOD_FR[zones.method] ?? zones.method} · confiance ${zones.confidence.toLowerCase()}`
              : "LTHR à renseigner"
          }
        />
      </div>
    </div>
  );
}

function dotClass(step: CardioStepView): string {
  if (step.kind === "work") {
    const z = step.target?.type === "hr_zone" ? (step.target.zone ?? 0) : 0;
    return z >= 4 ? "bg-cardio-hard" : "bg-cardio-easy";
  }
  if (step.kind === "recovery" || step.kind === "rest") return "bg-recovery";
  return "bg-fg-subtle";
}

/** The unrolled sequence exactly as the watch will run it. */
export function CardioTimeline({
  steps,
  hasZones,
}: {
  steps: CardioStepView[];
  hasZones: boolean;
}) {
  return (
    <Card>
      <CardTitle>Déroulé</CardTitle>
      {!hasZones ? (
        <p className="mt-1 text-[11px] text-fg-subtle">
          Zones sans bornes bpm : renseigne ta LTHR dans le profil pour guider la montre.
        </p>
      ) : null}
      <ol className="mt-2 flex flex-col">
        {steps.map((s) => (
          <li
            key={s.index}
            className="flex items-start gap-3 border-b border-border/60 py-2.5 last:border-b-0"
          >
            <span
              aria-hidden
              className={cn("mt-1.5 size-2.5 shrink-0 rounded-full", dotClass(s))}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium">
                  <span className="mr-1.5 text-xs text-fg-subtle tabular-nums">{s.index}</span>
                  {s.kindLabel}
                </span>
                <span className="shrink-0 text-sm text-fg tabular-nums">{s.extentLabel}</span>
              </div>
              <p className="text-sm text-fg-muted">
                {s.targetLabel}
                {s.notes ? ` · ${s.notes}` : ""}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function toVector(load: CardioLoadView): LoadVector {
  const v = emptyLoadVector();
  for (const d of load.vector) v[d.key] = d.value;
  return v;
}

export function ExpectedLoadCard({ load }: { load: CardioLoadView }) {
  return (
    <Card>
      <CardTitle>Stimuli attendus</CardTitle>
      <div className="mt-2 flex flex-wrap gap-2">
        {load.credits.length ? (
          load.credits.map((c) => (
            <Chip key={c.key} tone="accent">
              {c.label} {c.value.toFixed(1)}
            </Chip>
          ))
        ) : (
          <span className="text-sm text-fg-muted">—</span>
        )}
        {load.impactUnits > 0 ? (
          <Chip tone="neutral">≈ {Math.round(load.impactUnits * 10) / 10} impacts</Chip>
        ) : null}
      </div>
      <div className="mt-3">
        <LoadBars vector={toVector(load)} />
      </div>
      <p className="mt-1 text-[11px] text-fg-subtle">
        Estimation déterministe à partir des étapes (≈), pas une mesure.
      </p>
    </Card>
  );
}

export function CardioDoneCard({ view }: { view: CardioWorkoutView }) {
  return (
    <Card>
      <CardTitle>Bilan</CardTitle>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <Stat label="Durée" value={view.actualDurationMin} unit="min" />
        <Stat label="RPE" value={view.rpe} hint="déclaré" />
        <Stat label="Ressenti" value={view.feeling ? FEELING_FR[view.feeling] : null} />
      </div>
      {view.painReported ? (
        <p className="mt-2 text-sm text-warn">Douleur inhabituelle signalée pendant la séance.</p>
      ) : null}
      <Link
        href={`/workouts/${view.id}`}
        className="mt-3 inline-flex h-11 items-center font-semibold text-accent"
      >
        Voir le bilan complet →
      </Link>
    </Card>
  );
}
