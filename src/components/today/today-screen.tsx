"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useOptimistic, useState, useTransition } from "react";
import { Flame, HelpCircle, RefreshCw, Sparkles, Timer } from "lucide-react";
import type { Recommendation, Option } from "@/domain/engine";
import { isBonusOption } from "@/domain/engine";
import type { IntentKind } from "@/domain/core";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Chip, toneFor } from "@/components/ui/chip";
import { formatMinutes, formatDateShort, clockFromMinutes } from "@/lib/format";
import type { TodayView } from "@/server/services/view-models";
import { ReadinessChip } from "./readiness-chip";
import { WhySheet } from "./why-sheet";

type Actions = {
  declareIntent: (
    kind: IntentKind,
    intensity?: "easy" | "moderate" | "hard",
  ) => Promise<Recommendation | null>;
  acceptOption: (recommendationId: string | null, option: string) => Promise<void>;
  startOption: (option: Option) => Promise<{ href: string } | null>;
};

const INTENT_BUTTONS: Array<{ kind: IntentKind; label: string; icon?: React.ReactNode }> = [
  { kind: "going_crossfit", label: "Je vais au CrossFit" },
  { kind: "just_move", label: "Je veux juste bouger" },
  { kind: "rest", label: "Repos" },
  { kind: "feel_hot", label: "Je suis chaud", icon: <Flame className="size-4" /> },
  { kind: "lazy", label: "J'ai la flemme" },
  { kind: "have_time", label: "J'ai du temps", icon: <Timer className="size-4" /> },
  { kind: "surprise", label: "Surprise me", icon: <Sparkles className="size-4" /> },
];

export function TodayScreen({ view, actions }: { view: TodayView; actions: Actions }) {
  const router = useRouter();
  const [rec, setRec] = useOptimistic<Recommendation | null>(view.recommendation);
  const [altIndex, setAltIndex] = useState(-1); // -1 = primary
  const [pending, startTransition] = useTransition();
  const [why, setWhy] = useState(false);
  const [busyIntent, setBusyIntent] = useState<IntentKind | null>(null);

  const shown: Option | null = rec
    ? altIndex === -1
      ? rec.primary
      : (rec.alternatives[altIndex] ?? rec.primary)
    : null;
  const fixedToday = view.workouts.filter((w) => w.fixed && w.status !== "done");
  const done = view.workouts.filter((w) => w.status === "done");

  function cycleAlternative() {
    if (!rec || rec.alternatives.length === 0) return;
    const next = altIndex + 1 >= rec.alternatives.length ? -1 : altIndex + 1;
    setAltIndex(next);
    void actions.acceptOption(
      view.recommendationId,
      next === -1 ? "primary" : `alternative:${next}`,
    );
  }

  function declare(kind: IntentKind, intensity?: "easy" | "moderate" | "hard") {
    setBusyIntent(kind);
    startTransition(async () => {
      if (kind === "going_crossfit") {
        const r = await actions.declareIntent(kind);
        if (r) setRec(r);
        if (!fixedToday.some((w) => w.type === "crossfit"))
          router.push(`/inbox/new?for=${view.date}`);
        setBusyIntent(null);
        return;
      }
      const r = await actions.declareIntent(kind, intensity);
      if (r) {
        setRec(r);
        setAltIndex(-1);
      }
      setBusyIntent(null);
      router.refresh();
    });
  }

  function start() {
    if (!shown) return;
    startTransition(async () => {
      const res = await actions.startOption(shown);
      if (res?.href) router.push(res.href);
    });
  }

  return (
    <section className="flex flex-col gap-4 py-4">
      <header className="flex items-end justify-between">
        <div>
          <p className="text-sm text-fg-muted capitalize">{formatDateShort(view.date)}</p>
          <h1 className="text-3xl font-semibold tracking-tight">Aujourd&apos;hui</h1>
        </div>
        <ReadinessChip date={view.date} declared={view.readiness} />
      </header>

      {view.baselinePhase ? (
        <p className="rounded-xl bg-bg-muted/60 px-3 py-2 text-sm text-fg-muted">
          Athlete OS apprend ton profil : recommandations plus prudentes pendant les premières
          semaines.
        </p>
      ) : null}

      {view.inProgressWorkoutId ? (
        <Link
          href={`/train/strength/${view.inProgressWorkoutId}`}
          className="flex items-center justify-between rounded-2xl bg-strength/15 px-4 py-3 font-semibold text-strength"
        >
          Reprendre la séance en cours <span aria-hidden>→</span>
        </Link>
      ) : null}

      {rec && shown ? (
        <Card className="relative">
          <CardTitle>
            {altIndex === -1
              ? rec.primaryDone
                ? "Séance faite"
                : "Séance principale"
              : `Autre option ${altIndex + 1}/${rec.alternatives.length}`}
          </CardTitle>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Chip tone={toneFor(shown.family, shown.intensity)}>
              {shown.family.replace(/_/g, " ")}
            </Chip>
            {shown.intensity === "hard" ? (
              <Chip tone="cardioHard">intense</Chip>
            ) : shown.intensity === "easy" ? (
              <Chip tone="cardioEasy">facile</Chip>
            ) : null}
            {shown.fixed ? <Chip tone="neutral">fixé</Chip> : null}
          </div>
          <p className="mt-3 text-2xl font-semibold tracking-tight">
            {shown.title}
            {shown.timeOfDay && fixedToday[0]?.startMinute != null && shown.fixed ? (
              <span className="text-fg-muted">
                {" "}
                — {clockFromMinutes(fixedToday[0].startMinute)}
              </span>
            ) : null}
          </p>
          <p className="mt-1 text-sm text-fg-muted">
            {shown.durationMin > 0 ? formatMinutes(shown.durationMin) : "Récupération"}
          </p>
          <p className="mt-3 text-[15px] leading-snug text-fg">{rec.explanation}</p>
          {rec.advice.length ? (
            <ul className="mt-3 flex flex-col gap-1">
              {rec.advice.map((a) => (
                <li
                  key={a.code}
                  className={
                    a.code === "MEDICAL_ADVICE" ? "text-sm text-warn" : "text-sm text-fg-muted"
                  }
                >
                  {a.text}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-4 grid grid-cols-[1fr_auto_auto] gap-2">
            {rec.primaryDone && altIndex === -1 ? (
              <Button size="lg" variant="secondary" disabled>
                Faite ✓
              </Button>
            ) : (
              <Button size="lg" onClick={start} disabled={pending}>
                START
              </Button>
            )}
            <Button
              size="lg"
              variant="secondary"
              aria-label="Autre option"
              onClick={cycleAlternative}
              disabled={rec.alternatives.length === 0}
            >
              <RefreshCw className="size-5" />
            </Button>
            <Button
              size="lg"
              variant="secondary"
              aria-label="Pourquoi ?"
              onClick={() => setWhy(true)}
            >
              <HelpCircle className="size-5" />
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-fg-subtle">
            {rec.confidence.level === "HIGH"
              ? "Confiance élevée"
              : rec.confidence.level === "MEDIUM"
                ? "Confiance moyenne"
                : "Confiance faible — données partielles"}
            {rec.askFor.includes("wod") ? " · WOD inconnu : ajoute-le pour affiner" : ""}
            {rec.askFor.includes("rpe") ? " · RPE manquant sur une séance récente" : ""}
          </p>
        </Card>
      ) : (
        <Card>
          <CardTitle>Séance principale</CardTitle>
          <p className="mt-2 text-fg-muted">Calcul de la recommandation…</p>
          <Button className="mt-3" variant="secondary" onClick={() => router.refresh()}>
            Actualiser
          </Button>
        </Card>
      )}

      {rec ? (
        <Card>
          <CardTitle>Bonus</CardTitle>
          {isBonusOption(rec.bonus) ? (
            <>
              <p className="mt-2 text-lg font-semibold">{rec.bonus.title}</p>
              <p className="text-sm text-fg-muted">
                {formatMinutes(rec.bonus.durationMin)}
                {rec.bonus.timeOfDay
                  ? ` · ${rec.bonus.timeOfDay === "morning" ? "matin" : rec.bonus.timeOfDay === "midday" ? "midi" : "soir"}`
                  : ""}
              </p>
              <p className="mt-1 text-sm text-fg-muted">{rec.bonus.reason}</p>
            </>
          ) : (
            <p className="mt-2 text-sm text-fg-muted">{rec.bonus.reason}</p>
          )}
        </Card>
      ) : null}

      {done.length ? (
        <Card>
          <CardTitle>Fait aujourd&apos;hui</CardTitle>
          <ul className="mt-2 flex flex-col gap-1">
            {done.map((w) => (
              <li key={w.id} className="flex items-center justify-between text-sm">
                <Link href={`/workouts/${w.id}`} className="font-medium">
                  {w.title}
                </Link>
                <span className="text-fg-muted">{w.rpe ? `RPE ${w.rpe}` : "RPE ?"}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        {INTENT_BUTTONS.map((b) => (
          <Button
            key={b.kind}
            variant={view.activeIntentKind === b.kind ? "primary" : "outline"}
            size="md"
            onClick={() => declare(b.kind)}
            disabled={pending && busyIntent !== b.kind}
            className="justify-start"
          >
            {b.icon}
            {busyIntent === b.kind ? "…" : b.label}
          </Button>
        ))}
      </div>

      {view.insight ? <p className="px-1 text-sm text-fg-muted">{view.insight}</p> : null}

      {why && rec ? <WhySheet recommendation={rec} onClose={() => setWhy(false)} /> : null}
    </section>
  );
}
