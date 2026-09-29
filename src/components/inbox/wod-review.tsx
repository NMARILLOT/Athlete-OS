"use client";

import { useState, useTransition } from "react";
import {
  confirmInboxAction,
  discardInboxAction,
  reparseInboxAction,
} from "@/app/(app)/inbox/actions";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { Stat } from "@/components/ui/stat";
import { DIMENSION_LABEL_FR, STIMULUS_LABEL_FR } from "@/domain/engine";
import type { LoadDimension, StimulusKey } from "@/domain/core";
import type { InboxItemView } from "@/server/services/view-models";
import { ErrorNote } from "@/components/log/fields";
import { isNextRedirect } from "@/lib/next-redirect";

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
const KIND_FR: Record<string, string> = {
  warmup: "Échauffement",
  strength: "Force",
  skill: "Skill",
  metcon: "Metcon",
  accessory: "Accessoires",
  cooldown: "Retour au calme",
};

/** Read-only structure + "C'est ça / Corriger le texte" (ARCHITECTURE §4 inbox flow). */
export function WodReview({ item, today }: { item: InboxItemView; today: string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.rawText ?? "");
  const [date, setDate] = useState(item.scheduledFor ?? today);
  const [start, setStart] = useState(item.startLocal ? item.startLocal.slice(0, 5) : "18:30");
  const [pending, run] = useTransition();
  const [error, setError] = useState<string | null>(null);
  /** Runs a server action in the transition; Next redirects are not failures (spec: never a dead end). */
  const guarded = (fn: () => Promise<void>) =>
    run(async () => {
      setError(null);
      try {
        await fn();
      } catch (err) {
        if (isNextRedirect(err)) throw err;
        setError("Impossible d'enregistrer pour le moment. Vérifie ta connexion et réessaie.");
      }
    });
  const wod = item.normalizedWod;
  const a = item.analysis;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Chip
          tone={
            item.status === "needs_review"
              ? "warn"
              : item.status === "confirmed"
                ? "accent"
                : "neutral"
          }
        >
          {item.status === "needs_review"
            ? "À vérifier"
            : item.status === "confirmed"
              ? "Confirmé"
              : "Analysé"}
        </Chip>
        <Chip tone="neutral">
          {item.parseSource === "AI_PARSED" ? "IA" : "heuristique"} · confiance{" "}
          {Math.round((item.parseConfidence ?? 0) * 100)} %
        </Chip>
        {a?.unknownMovements.length ? (
          <Chip tone="warn">{a.unknownMovements.length} mouvement(s) inconnu(s)</Chip>
        ) : null}
      </div>

      {editing || !wod ? (
        <Card>
          <CardTitle>Texte du WOD</CardTitle>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={10}
            className="mt-2 w-full rounded-xl border border-border bg-bg-muted/60 p-3 text-sm"
          />
          <div className="mt-3 flex gap-2">
            <Button
              onClick={() =>
                guarded(async () => {
                  await reparseInboxAction(item.id, text);
                  setEditing(false);
                })
              }
              disabled={pending}
            >
              {pending ? "Analyse…" : "Ré-analyser"}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Annuler
            </Button>
          </div>
        </Card>
      ) : (
        <Card>
          <CardTitle>Structure</CardTitle>
          <ol className="mt-2 flex flex-col gap-3">
            {wod.parts.map((p, i) => (
              <li key={i}>
                <p className="text-sm font-semibold">
                  {KIND_FR[p.kind] ?? p.kind} · {FORMAT_FR[p.format] ?? p.format}
                  {p.durationMin ? ` ${p.durationMin} min` : ""}
                  {p.rounds ? ` · ${p.rounds} rounds` : ""}
                  {p.repScheme ? ` · ${p.repScheme.join("-")}` : ""}
                  {p.sets && p.reps ? ` · ${p.sets}×${p.reps}` : ""}
                  {p.timeCapMin ? ` · cap ${p.timeCapMin}'` : ""}
                </p>
                <ul className="mt-1 flex flex-col gap-0.5 text-sm text-fg-muted">
                  {p.movements.map((m, j) => (
                    <li key={j} className={m.exerciseId ? "" : "text-warn"}>
                      {m.reps != null ? `${m.reps} ` : ""}
                      {m.calories != null ? `${m.calories} cal ` : ""}
                      {m.distanceM != null ? `${m.distanceM} m ` : ""}
                      {m.durationSec != null ? `${Math.round(m.durationSec / 60)} min ` : ""}
                      {m.name}
                      {m.load
                        ? ` ${m.load.value ? m.load.value : ""}${m.load.alt ? "/" + m.load.alt : ""}${m.load.value ? (m.load.unit === "percent_1rm" ? " %" : " " + m.load.unit) : ""}${m.load.qualifier ? " " + m.load.qualifier : ""}`
                        : ""}
                      {!m.exerciseId ? " (non reconnu)" : ""}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
          {wod.warnings.length ? (
            <p className="mt-2 text-xs text-warn">{wod.warnings.join(" · ")}</p>
          ) : null}
          <button
            type="button"
            className="mt-3 text-sm text-fg-muted underline-offset-4 hover:underline"
            onClick={() => setEditing(true)}
          >
            Corriger le texte
          </button>
        </Card>
      )}

      {a ? (
        <Card>
          <CardTitle>Analyse (déterministe)</CardTitle>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <Stat label="Durée" value={a.estimatedDurationMin} unit="min" estimated />
            <Stat
              label="Intensité"
              value={
                a.intensity === "hard" ? "dure" : a.intensity === "moderate" ? "modérée" : "facile"
              }
              estimated
            />
            <Stat
              label="Time domain"
              value={
                a.timeDomain === "short" ? "court" : a.timeDomain === "medium" ? "moyen" : "long"
              }
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {a.tags.map((t) => (
              <Chip key={t} tone="neutral">
                {t.replace(/_/g, " ")}
              </Chip>
            ))}
          </div>
          <p className="mt-3 text-xs font-semibold tracking-wide text-fg-muted uppercase">Charge</p>
          <ul className="mt-1 grid grid-cols-3 gap-2 text-sm">
            {(Object.entries(a.loadVector) as Array<[LoadDimension, number]>).map(([d, v]) => (
              <li key={d} className="rounded-xl bg-bg-muted/60 px-3 py-2">
                <span className="block text-[11px] text-fg-subtle">{DIMENSION_LABEL_FR[d]}</span>
                <span className="font-semibold">{v.toFixed(1)}</span>
                <span className="text-fg-subtle">/10</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs font-semibold tracking-wide text-fg-muted uppercase">
            Stimuli crédités
          </p>
          <div className="mt-1 flex flex-wrap gap-2">
            {(Object.entries(a.stimulusCredits) as Array<[StimulusKey, number]>).map(([k, v]) => (
              <Chip key={k} tone="accent">
                {STIMULUS_LABEL_FR[k]} {v.toFixed(1)}
              </Chip>
            ))}
          </div>
        </Card>
      ) : null}

      {item.status !== "confirmed" && item.status !== "discarded" ? (
        <Card>
          <CardTitle>Planifier</CardTitle>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">Date</span>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="h-12 rounded-xl border border-border bg-bg-muted/60 px-3"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">Heure</span>
              <input
                type="time"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="h-12 rounded-xl border border-border bg-bg-muted/60 px-3"
              />
            </label>
          </div>
          <ErrorNote message={error} />
          <div className="mt-3 flex gap-2">
            <Button
              size="lg"
              className="flex-1"
              disabled={pending || !wod}
              onClick={() => guarded(() => confirmInboxAction(item.id, date, start || null))}
            >
              {pending ? "…" : "C'est ça, je le fais"}
            </Button>
            <Button
              size="lg"
              variant="ghost"
              disabled={pending}
              onClick={() => guarded(() => discardInboxAction(item.id))}
            >
              Ignorer
            </Button>
          </div>
        </Card>
      ) : item.workoutId ? (
        <p className="text-sm text-fg-muted">
          Séance créée :{" "}
          <a className="text-accent" href={`/workouts/${item.workoutId}`}>
            voir la séance
          </a>
        </p>
      ) : null}
    </div>
  );
}
