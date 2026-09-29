import Link from "next/link";
import { Card, CardTitle } from "@/components/ui/card";
import { Chip, toneFor } from "@/components/ui/chip";
import { Stat } from "@/components/ui/stat";
import type { IntensityBand, WorkoutStatus, WorkoutType } from "@/domain/core";
import type {
  AnalysisView,
  CardioDetail,
  CoachDetail,
  CrossfitDetail,
  LinkedActivityView,
  StrengthDetail,
  WhyView,
  WorkoutDetailView,
} from "@/server/services/workout-detail.service";
import {
  clockFromMinutes,
  formatDateShort,
  formatDurationSec,
  formatKg,
  formatKm,
  formatMinutes,
} from "@/lib/format";

/** Server-rendered blocks of `/workouts/[id]` (plain data in, no client state). */

export const TYPE_FR: Record<WorkoutType, string> = {
  strength: "Force",
  cardio: "Cardio",
  crossfit: "CrossFit",
  coach_session: "Coaching",
  mobility: "Mobilité",
  free: "Libre",
  rest: "Repos",
};

export const STATUS_FR: Record<WorkoutStatus, string> = {
  planned: "Prévu",
  in_progress: "En cours",
  done: "Terminé",
  skipped: "Sauté",
  auto_adjusted: "Replanifié",
};

const INTENSITY_FR: Record<IntensityBand, string> = {
  easy: "facile",
  moderate: "modérée",
  hard: "dure",
};

const SOURCE_FR: Record<string, string> = {
  planned_engine: "proposée par le moteur",
  planned_user: "planifiée par toi",
  manual: "saisie manuelle",
  garmin: "Garmin",
  fit_import: "import FIT",
  wod_inbox: "WOD Inbox",
};

const CONFIDENCE_FR: Record<string, string> = { HIGH: "haute", MEDIUM: "moyenne", LOW: "basse" };

export function WorkoutHeader({ w }: { w: WorkoutDetailView }) {
  const status: WorkoutStatus = w.status;
  const statusTone =
    status === "done"
      ? "accent"
      : status === "skipped"
        ? "neutral"
        : status === "in_progress"
          ? "info"
          : "neutral";
  const intensity = w.realisedIntensity ?? w.plannedIntensity;
  // A done session without a measured/declared duration shows the planned one, flagged "≈ prévue".
  const durationMeasured = w.status === "done" && w.actualDurationMin != null;
  const duration =
    w.status === "done" ? (w.actualDurationMin ?? w.plannedDurationMin) : w.plannedDurationMin;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={toneFor(w.type, intensity)}>{TYPE_FR[w.type]}</Chip>
        <Chip tone={statusTone}>{STATUS_FR[status]}</Chip>
        {w.fixed ? <Chip tone="neutral">fixé</Chip> : null}
      </div>
      <p className="text-sm text-fg-muted">
        {formatDateShort(w.date)}
        {w.startMinute != null ? ` · ${clockFromMinutes(w.startMinute)}` : ""}
        {duration ? ` · ${formatMinutes(duration)}` : ""}
        {w.type !== "rest" ? ` · ${SOURCE_FR[w.source] ?? w.source}` : ""}
      </p>
      {w.type !== "rest" ? (
        <div className="grid grid-cols-3 gap-2">
          <Stat
            label="Durée"
            value={duration ? formatMinutes(duration) : null}
            estimated={w.status === "done" && !durationMeasured}
            hint={durationMeasured ? "réelle" : w.status === "done" ? "≈ prévue" : "prévue"}
          />
          <Stat
            label="Intensité"
            value={intensity ? INTENSITY_FR[intensity] : null}
            estimated={w.intensitySource !== "USER"}
            hint={w.intensitySource === "USER" ? "déclarée" : "estimée"}
          />
          <Stat
            label="Charge"
            value={w.sessionRpeLoad != null ? Math.round(w.sessionRpeLoad) : null}
            unit="AU"
            hint={w.sessionRpeLoad != null ? "durée × RPE" : "RPE manquant"}
          />
        </div>
      ) : null}
      {w.notes ? <p className="text-sm whitespace-pre-line text-fg-muted">{w.notes}</p> : null}
    </div>
  );
}

function prescriptionText(p: NonNullable<StrengthDetail["exercises"][number]["prescription"]>) {
  const reps = p.repMin === p.repMax ? `${p.repMin}` : `${p.repMin}–${p.repMax}`;
  const rpe =
    p.targetRpeMin === p.targetRpeMax
      ? `RPE ${p.targetRpeMin}`
      : `RPE ${p.targetRpeMin}–${p.targetRpeMax}`;
  return `${p.sets} × ${reps} · ${rpe}${p.loadSuggestionKg != null ? ` · ≈ ${formatKg(p.loadSuggestionKg)}` : ""}`;
}

export function StrengthBlock({ s }: { s: StrengthDetail }) {
  return (
    <Card>
      <CardTitle>Exercices</CardTitle>
      {s.workingSets > 0 ? (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Stat label="Séries" value={s.workingSets} hint="hors échauffement" />
          <Stat label="Volume" value={s.volumeKg} unit="kg" hint="reps × kg" />
        </div>
      ) : null}
      <ol className="mt-3 flex flex-col gap-3">
        {s.exercises.map((e) => (
          <li key={e.id}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <Link href={`/exercises/${e.exerciseId}`} className="font-semibold">
                  {e.name}
                </Link>
                {e.prescription ? (
                  <p className="text-xs text-fg-muted">{prescriptionText(e.prescription)}</p>
                ) : null}
              </div>
              {e.bestSetE1rmKg != null ? (
                <div className="text-right">
                  <p className="text-xs text-fg-subtle">e1RM</p>
                  <p className="font-semibold tabular-nums">≈ {formatKg(e.bestSetE1rmKg)}</p>
                  {e.isPr ? (
                    <Chip tone="accent" className="mt-1">
                      PR{e.previousBestKg != null ? ` (av. ≈ ${formatKg(e.previousBestKg)})` : ""}
                    </Chip>
                  ) : null}
                </div>
              ) : null}
            </div>
            {e.sets.length ? (
              <ul className="mt-1.5 flex flex-col gap-0.5 text-sm">
                {e.sets.map((set, i) => (
                  <li
                    key={set.id}
                    className={
                      set.isWarmup
                        ? "flex justify-between text-fg-subtle"
                        : "flex justify-between text-fg-muted"
                    }
                  >
                    <span>
                      {i + 1}. {set.reps ?? "—"} ×{" "}
                      {set.weightKg != null ? formatKg(set.weightKg) : "—"}
                      {set.isWarmup ? " · échauffement" : ""}
                      {set.rpe != null ? ` · RPE ${set.rpe}` : ""}
                    </span>
                    {!set.isWarmup && set.e1rmKg != null ? (
                      <span className={set.id === e.bestSetId && e.isPr ? "text-accent" : ""}>
                        ≈ {formatKg(set.e1rmKg)}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-fg-subtle">Aucune série enregistrée.</p>
            )}
          </li>
        ))}
        {s.exercises.length === 0 ? (
          <li className="text-sm text-fg-muted">Aucun exercice planifié.</li>
        ) : null}
      </ol>
    </Card>
  );
}

const FORMAT_FR: Record<string, string> = {
  for_time: "For time",
  amrap: "AMRAP",
  emom: "EMOM",
  intervals: "Intervalles",
  sets_reps: "Séries × reps",
  tabata: "Tabata",
  chipper: "Chipper",
  ladder: "Ladder",
  not_timed: "Libre",
};
const PART_FR: Record<string, string> = {
  warmup: "Échauffement",
  strength: "Force",
  skill: "Skill",
  metcon: "Metcon",
  accessory: "Accessoires",
  cooldown: "Retour au calme",
};

export function scoreText(score: NonNullable<CrossfitDetail["score"]>): string {
  switch (score.kind) {
    case "time":
      return formatDurationSec(score.value);
    case "rounds_reps":
      return `${score.value} rounds${score.extraReps ? ` + ${score.extraReps}` : ""}`;
    case "reps":
      return `${score.value} reps`;
    case "load":
      return formatKg(score.value);
  }
}

export function CrossfitBlock({ c }: { c: CrossfitDetail }) {
  return (
    <Card>
      <CardTitle>WOD</CardTitle>
      {c.score ? (
        <div className="mt-2 flex items-center gap-2">
          <Stat label="Score" value={scoreText(c.score)} className="flex-1" hint="déclaré" />
          <Chip tone={c.score.rx ? "accent" : "neutral"}>{c.score.rx ? "RX" : "Scaled"}</Chip>
        </div>
      ) : null}
      {c.score?.scaledNotes ? (
        <p className="mt-1 text-xs text-fg-muted">{c.score.scaledNotes}</p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {c.benchmarkName ? <Chip tone="crossfit">Benchmark · {c.benchmarkName}</Chip> : null}
        {c.timeDomain ? (
          <Chip tone="neutral">
            {c.timeDomain === "short" ? "court" : c.timeDomain === "medium" ? "moyen" : "long"}
          </Chip>
        ) : null}
      </div>
      {c.wod ? (
        <ol className="mt-3 flex flex-col gap-3">
          {c.wod.parts.map((p, i) => (
            <li key={i}>
              <p className="text-sm font-semibold">
                {PART_FR[p.kind] ?? p.kind} · {FORMAT_FR[p.format] ?? p.format}
                {p.durationMin ? ` ${p.durationMin} min` : ""}
                {p.rounds ? ` · ${p.rounds} rounds` : ""}
                {p.repScheme ? ` · ${p.repScheme.join("-")}` : ""}
                {p.sets && p.reps ? ` · ${p.sets}×${p.reps}` : ""}
                {p.timeCapMin ? ` · cap ${p.timeCapMin}'` : ""}
              </p>
              <ul className="mt-1 flex flex-col gap-0.5 text-sm text-fg-muted">
                {p.movements.map((m, j) => (
                  <li key={j}>
                    {m.reps != null ? `${m.reps} ` : ""}
                    {m.calories != null ? `${m.calories} cal ` : ""}
                    {m.distanceM != null ? `${m.distanceM} m ` : ""}
                    {m.durationSec != null ? `${Math.round(m.durationSec / 60)} min ` : ""}
                    {m.name}
                    {m.load?.value
                      ? ` ${m.load.value}${m.load.alt ? "/" + m.load.alt : ""} ${m.load.unit === "percent_1rm" ? "%" : m.load.unit}`
                      : ""}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 text-sm text-fg-muted">WOD non renseigné.</p>
      )}
    </Card>
  );
}

const MODALITY_FR: Record<string, string> = {
  running: "Course",
  bike: "Vélo",
  row: "Rameur",
  ski: "SkiErg",
  swimming: "Natation",
  walking: "Marche",
  other: "Autre",
};
const CARDIO_KIND_FR: Record<string, string> = {
  zone2: "Zone 2",
  long: "Sortie longue",
  recovery: "Récupération",
  tempo: "Tempo",
  threshold: "Seuil",
  vo2max: "VO2max",
  intervals: "Intervalles",
  fartlek: "Fartlek",
  hills: "Côtes",
  strides: "Strides",
  test: "Test",
  free: "Libre",
};
const STEP_FR: Record<string, string> = {
  warmup: "Échauffement",
  work: "Effort",
  recovery: "Récup",
  cooldown: "Retour au calme",
  rest: "Repos",
};
const GARMIN_FR: Record<string, string> = {
  not_sent: "non envoyé à Garmin",
  pending: "envoi Garmin en attente",
  synced: "synchronisé sur Garmin",
  failed: "envoi Garmin échoué",
};

export function CardioBlock({ c }: { c: CardioDetail }) {
  return (
    <Card>
      <CardTitle>Séance cardio</CardTitle>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <Stat label="Sport" value={MODALITY_FR[c.modality] ?? c.modality} />
        <Stat label="Type" value={CARDIO_KIND_FR[c.kind] ?? c.kind} />
        <Stat label="Total" value={c.estimatedDurationMin} unit="min" estimated />
      </div>
      <p className="mt-2 text-xs text-fg-muted">
        {c.stepCount} étape{c.stepCount > 1 ? "s" : ""} ·{" "}
        {GARMIN_FR[c.garminSyncStatus] ?? c.garminSyncStatus}
      </p>
      {c.lastSyncError ? <p className="mt-1 text-xs text-warn">{c.lastSyncError}</p> : null}
      {c.steps.length ? (
        <ol className="mt-2 flex flex-col gap-0.5 text-sm text-fg-muted">
          {c.steps.map((s, i) => (
            <li key={i} className="flex justify-between">
              <span>
                {STEP_FR[s.kind] ?? s.kind}
                {s.target ? ` · ${s.target}` : ""}
              </span>
              <span className="tabular-nums">
                {s.durationSec != null
                  ? formatDurationSec(s.durationSec)
                  : s.distanceM != null
                    ? formatKm(s.distanceM)
                    : "au bouton"}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </Card>
  );
}

const DEMO_FR: Record<string, string> = {
  none: "aucune",
  light: "légère",
  moderate: "modérée",
  heavy: "importante",
};

export function CoachBlock({ c }: { c: CoachDetail }) {
  return (
    <Card>
      <CardTitle>Coaching</CardTitle>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <Stat label="Démo" value={DEMO_FR[c.demoLevel] ?? c.demoLevel} hint="déclarée" />
        <Stat label="Debout" value={formatMinutes(c.standingMinutes)} hint="déclaré" />
        <Stat
          label="Fatigue"
          value={c.perceivedFatigue != null ? `${c.perceivedFatigue}/5` : null}
          hint="ressentie"
        />
      </div>
      <p className="mt-2 text-xs text-fg-subtle">
        Pas une séance d&apos;entraînement : compte seulement dans le contexte de récupération.
      </p>
    </Card>
  );
}

export function WhyBlock({ why }: { why: WhyView }) {
  return (
    <details className="group rounded-2xl border border-border bg-bg-elevated shadow-[var(--shadow-card)]">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between px-4 py-3 text-xs font-semibold tracking-[0.14em] text-fg-muted uppercase select-none [&::-webkit-details-marker]:hidden">
        Pourquoi cette séance
        <span aria-hidden className="text-fg-subtle transition-transform group-open:rotate-180">
          ▾
        </span>
      </summary>
      <div className="px-4 pb-4">
        <p className="text-[15px]">
          {why.explanation || "Le moteur a proposé cette séance sans contrainte particulière."}
        </p>
        {why.rulesTriggered.length ? (
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {why.rulesTriggered.slice(0, 10).map((r) => (
              <li
                key={r}
                className="rounded-full bg-bg-muted/60 px-2.5 py-1 font-mono text-[11px] text-accent"
              >
                {r}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="mt-3 text-[11px] text-fg-subtle">
          Recommandation du {formatDateShort(why.date)} · confiance{" "}
          {CONFIDENCE_FR[why.confidence] ?? why.confidence.toLowerCase()}
        </p>
      </div>
    </details>
  );
}

function pct(v: number): number {
  return Math.max(0, Math.min(100, (v / 10) * 100));
}

export function AnalysisBlock({
  planned,
  actual,
}: {
  planned: AnalysisView | null;
  actual: AnalysisView | null;
}) {
  const ref = actual ?? planned;
  if (!ref) return null;
  const dims = ref.load.map((l) => l.key);
  const credits = actual?.credits.length ? actual.credits : (planned?.credits ?? []);
  return (
    <Card>
      <CardTitle>Charge estimée</CardTitle>
      <p className="mt-1 text-[11px] text-fg-subtle">
        ≈ modèle, pas une mesure · 0–10 par dimension
        {planned && actual ? " · prévu (gris) vs réel (vert)" : planned ? " · prévu" : " · réel"}
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {dims.map((key) => {
          const p = planned?.load.find((l) => l.key === key)?.value ?? null;
          const a = actual?.load.find((l) => l.key === key)?.value ?? null;
          const label = ref.load.find((l) => l.key === key)?.label ?? key;
          return (
            <li key={key}>
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-fg-muted">{label}</span>
                <span className="tabular-nums">
                  {p != null ? <span className="text-fg-subtle">≈ {p.toFixed(1)}</span> : null}
                  {p != null && a != null ? <span className="text-fg-subtle"> → </span> : null}
                  {a != null ? <span className="font-semibold">≈ {a.toFixed(1)}</span> : null}
                </span>
              </div>
              <div className="mt-1 flex flex-col gap-0.5">
                {p != null ? (
                  <div className="h-1.5 w-full rounded-full bg-bg-muted">
                    <div
                      className="h-1.5 rounded-full bg-fg-subtle/60"
                      style={{ width: `${pct(p)}%` }}
                    />
                  </div>
                ) : null}
                {a != null ? (
                  <div className="h-1.5 w-full rounded-full bg-bg-muted">
                    <div className="h-1.5 rounded-full bg-accent" style={{ width: `${pct(a)}%` }} />
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {credits.length ? (
        <>
          <p className="mt-4 text-xs font-semibold tracking-wide text-fg-muted uppercase">
            Stimuli crédités
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {credits.map((c) => (
              <Chip key={c.key} tone="accent">
                {c.label} ≈ {c.value.toFixed(1)}
              </Chip>
            ))}
          </div>
        </>
      ) : null}
      <p className="mt-3 text-[11px] text-fg-subtle">
        Intensité {INTENSITY_FR[ref.intensity]} · confiance{" "}
        {CONFIDENCE_FR[ref.confidence] ?? ref.confidence} ·{" "}
        {ref.source === "ENGINE" ? "moteur" : ref.source === "AI_PARSED" ? "IA" : "calculée"} ·{" "}
        {ref.algorithmVersion}
      </p>
    </Card>
  );
}

export function ActivitiesBlock({ list }: { list: LinkedActivityView[] }) {
  if (!list.length) return null;
  return (
    <Card>
      <CardTitle>Activités mesurées</CardTitle>
      <ul className="mt-2 flex flex-col gap-1">
        {list.map((a) => (
          <li key={a.id}>
            <Link
              href={`/activities/${a.id}`}
              className="flex items-center justify-between text-sm"
            >
              <span className="font-medium">
                {a.sport} · {formatDurationSec(a.durationSec)}
              </span>
              <span className="text-fg-muted tabular-nums">
                {a.distanceM != null ? formatKm(a.distanceM) : "—"}
                {a.avgHr != null ? ` · ${a.avgHr} bpm` : ""}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-fg-subtle">
        {list[0]?.provider === "garmin_mock"
          ? "Simulé (mock Garmin de développement)."
          : `Mesuré (${list[0]?.provider === "garmin" ? "Garmin" : "fichier FIT"}).`}
      </p>
    </Card>
  );
}
