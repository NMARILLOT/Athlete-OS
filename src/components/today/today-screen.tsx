"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useOptimistic, useState, useTransition } from "react";
import { Flame, HelpCircle, RefreshCw, Send, Sparkles, Timer } from "lucide-react";
import type { Recommendation, Option } from "@/domain/engine";
import { isBonusOption } from "@/domain/engine";
import { INTENT_KIND_VALUES, type IntentKind } from "@/domain/core";
import { clearIntentAction, declareFreeTextIntentAction } from "@/app/(app)/today/actions";
import { ErrorNote } from "@/components/log/fields";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Chip, toneFor } from "@/components/ui/chip";
import { cn } from "@/lib/cn";
import { formatMinutes, formatDateShort, clockFromMinutes } from "@/lib/format";
import { isNextRedirect } from "@/lib/next-redirect";
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
  applyReschedule: (plannedId: string) => Promise<{ applied: number }>;
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

/** Spec §32/§33 wishes: what the athlete wants (or refuses) today, as one-tap chips. */
const WISH_CHIPS: Array<{ kind: IntentKind; label: string }> = [
  { kind: "want_run", label: "Courir" },
  { kind: "want_bike", label: "Vélo" },
  { kind: "want_row", label: "Rameur" },
  { kind: "want_strength", label: "Muscu" },
  { kind: "no_legs", label: "Pas de jambes" },
  { kind: "no_strength", label: "Pas de muscu" },
];

const INTENT_LABEL_FR: Record<IntentKind, string> = {
  want_run: "courir",
  want_bike: "vélo",
  want_row: "rameur",
  want_crossfit: "CrossFit",
  want_strength: "muscu",
  want_hyrox: "Hyrox",
  want_big_session: "grosse séance",
  no_strength: "pas de muscu",
  no_legs: "pas de jambes",
  going_crossfit: "CrossFit prévu",
  just_move: "juste bouger",
  rest: "repos",
  feel_hot: "en forme",
  lazy: "flemme",
  have_time: "du temps",
  surprise: "surprise",
  custom: "",
};

/** Kinds that already have a button or a chip on screen (others get the "Envie du jour" line). */
const LISTED_KINDS = new Set<IntentKind>([
  ...INTENT_BUTTONS.map((b) => b.kind),
  ...WISH_CHIPS.map((c) => c.kind),
]);

function isIntentKind(v: string | null): v is IntentKind {
  return v != null && (INTENT_KIND_VALUES as readonly string[]).includes(v);
}

const ACTION_ERROR = "Impossible d'enregistrer pour le moment. Vérifie ta connexion et réessaie.";

export function TodayScreen({ view, actions }: { view: TodayView; actions: Actions }) {
  const router = useRouter();
  const [rec, setRec] = useOptimistic<Recommendation | null>(view.recommendation);
  const [altIndex, setAltIndex] = useState(-1); // -1 = primary
  const [pending, startTransition] = useTransition();
  const [why, setWhy] = useState(false);
  const [busyIntent, setBusyIntent] = useState<IntentKind | null>(null);
  const [wish, setWish] = useState("");
  const [wishNote, setWishNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyReschedule, setBusyReschedule] = useState<string | null>(null);

  const shown: Option | null = rec
    ? altIndex === -1
      ? rec.primary
      : (rec.alternatives[altIndex] ?? rec.primary)
    : null;
  const fixedToday = view.workouts.filter((w) => w.fixed && w.status !== "done");
  const done = view.workouts.filter((w) => w.status === "done");
  const activeKind = isIntentKind(view.activeIntentKind) ? view.activeIntentKind : null;
  /** An intent declared by free text that no button/chip shows (Hyrox, CrossFit, big session, not understood). */
  const unlistedActive = activeKind && !LISTED_KINDS.has(activeKind) ? activeKind : null;

  /** Shows the inline error unless Next is redirecting (that rejection is not a failure). */
  function fail(err: unknown) {
    if (isNextRedirect(err)) throw err;
    setError(ACTION_ERROR);
  }

  function cycleAlternative() {
    if (!rec || rec.alternatives.length === 0) return;
    const next = altIndex + 1 >= rec.alternatives.length ? -1 : altIndex + 1;
    setAltIndex(next);
    // Bookkeeping only (which option was shown): a failure must not block the athlete.
    actions
      .acceptOption(view.recommendationId, next === -1 ? "primary" : `alternative:${next}`)
      .catch(() => undefined);
  }

  function declare(kind: IntentKind, intensity?: "easy" | "moderate" | "hard") {
    setError(null);
    setWishNote(null);
    setBusyIntent(kind);
    startTransition(async () => {
      try {
        if (kind === "going_crossfit") {
          const r = await actions.declareIntent(kind);
          if (r) setRec(r);
          if (!fixedToday.some((w) => w.type === "crossfit"))
            router.push(`/inbox/new?for=${view.date}`);
          return;
        }
        const r = await actions.declareIntent(kind, intensity);
        if (r) {
          setRec(r);
          setAltIndex(-1);
        }
        router.refresh();
      } catch (err) {
        fail(err);
      } finally {
        setBusyIntent(null);
      }
    });
  }

  /** Tapping the active intent again withdraws it (back to "no intent"). */
  function clear(kind: IntentKind) {
    setError(null);
    setWishNote(null);
    setBusyIntent(kind);
    startTransition(async () => {
      try {
        await clearIntentAction();
        setAltIndex(-1);
        router.refresh();
      } catch (err) {
        fail(err);
      } finally {
        setBusyIntent(null);
      }
    });
  }

  function toggleIntent(kind: IntentKind) {
    if (view.activeIntentKind === kind) clear(kind);
    else declare(kind);
  }

  function submitWish(e: React.FormEvent) {
    e.preventDefault();
    const text = wish.trim();
    if (text.length < 2) return;
    setError(null);
    setWishNote(null);
    startTransition(async () => {
      try {
        const r = await declareFreeTextIntentAction(text);
        if (r) {
          setRec(r);
          setAltIndex(-1);
        }
        // What was understood shows up from the refreshed view: a highlighted chip, or the
        // "Envie du jour" line for kinds without a chip (and for a wish that was not recognised).
        setWishNote("Envie notée.");
        setWish("");
        router.refresh();
      } catch (err) {
        fail(err);
      }
    });
  }

  /** Spec §32/§53: the engine proposes, the athlete applies (one tap → moveWorkout → recompute). */
  function applyReschedule(plannedId: string) {
    setError(null);
    setBusyReschedule(plannedId);
    startTransition(async () => {
      try {
        await actions.applyReschedule(plannedId);
        router.refresh();
      } catch (err) {
        fail(err);
      } finally {
        setBusyReschedule(null);
      }
    });
  }

  function start() {
    if (!shown) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await actions.startOption(shown);
        if (res?.href) router.push(res.href);
      } catch (err) {
        fail(err);
      }
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
          href={
            view.inProgressWorkoutType === "cardio"
              ? `/train/cardio/${view.inProgressWorkoutId}`
              : `/train/strength/${view.inProgressWorkoutId}`
          }
          className="flex items-center justify-between rounded-2xl bg-strength/15 px-4 py-3 font-semibold text-strength"
        >
          Reprendre la séance en cours <span aria-hidden>→</span>
        </Link>
      ) : null}

      <ErrorNote message={error} />

      {view.reschedules.length ? (
        <Card>
          <CardTitle>Replanification proposée</CardTitle>
          <ul className="mt-2 flex flex-col gap-3">
            {view.reschedules.map((r) => (
              <li key={r.plannedId} className="flex flex-col gap-1">
                <p className="text-[15px] font-medium">
                  {r.title}
                  <span className="text-fg-muted">
                    {" "}
                    →{" "}
                    {r.toDate ? formatDateShort(r.toDate) : "pas de jour compatible cette semaine"}
                  </span>
                </p>
                <p className="text-sm text-fg-muted">{r.reason}</p>
                <div className="flex gap-2">
                  {r.toDate ? (
                    <Button
                      size="sm"
                      onClick={() => applyReschedule(r.plannedId)}
                      disabled={pending}
                    >
                      {busyReschedule === r.plannedId ? "…" : "Déplacer"}
                    </Button>
                  ) : null}
                  <Link
                    href={`/workouts/${r.plannedId}`}
                    className="inline-flex h-9 items-center rounded-lg px-3 text-sm font-semibold text-fg-muted"
                  >
                    Voir la séance
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </Card>
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
            aria-pressed={view.activeIntentKind === b.kind}
            onClick={() => toggleIntent(b.kind)}
            disabled={pending && busyIntent !== b.kind}
            className="justify-start"
          >
            {b.icon}
            {busyIntent === b.kind ? "…" : b.label}
          </Button>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        <p className="px-1 text-xs font-semibold tracking-[0.14em] text-fg-muted uppercase">
          Envie de…
        </p>
        <div
          className="-mx-4 flex [scrollbar-width:none] gap-2 overflow-x-auto px-4 pb-1"
          role="group"
          aria-label="Envie de…"
        >
          {WISH_CHIPS.map((c) => {
            const active = view.activeIntentKind === c.kind;
            return (
              <button
                key={c.kind}
                type="button"
                aria-pressed={active}
                onClick={() => toggleIntent(c.kind)}
                disabled={pending && busyIntent !== c.kind}
                className={cn(
                  "h-10 shrink-0 rounded-full px-4 text-sm font-semibold whitespace-nowrap transition-colors select-none disabled:opacity-50",
                  active ? "bg-accent text-accent-fg" : "bg-bg-muted text-fg",
                )}
              >
                {busyIntent === c.kind ? "…" : c.label}
              </button>
            );
          })}
        </div>
        <form onSubmit={submitWish} className="flex gap-2">
          <input
            value={wish}
            onChange={(e) => setWish(e.target.value)}
            placeholder="J'ai envie de…"
            aria-label="J'ai envie de…"
            maxLength={300}
            enterKeyHint="send"
            autoComplete="off"
            className="h-12 min-w-0 flex-1 rounded-xl border border-border bg-bg-elevated px-4 text-base outline-none focus:border-accent"
          />
          <Button
            type="submit"
            variant="secondary"
            aria-label="Envoyer"
            disabled={pending || wish.trim().length < 2}
          >
            <Send className="size-5" />
          </Button>
        </form>
        {wishNote ? <p className="px-1 text-sm text-fg-muted">{wishNote}</p> : null}
        {unlistedActive ? (
          <div className="flex items-center justify-between gap-3 rounded-xl bg-bg-muted/60 px-3 py-2 text-sm">
            <span className="text-fg-muted">
              {unlistedActive === "custom"
                ? "Envie notée mais pas reconnue — essaie « courir », « vélo », « pas de jambes »…"
                : `Envie du jour : ${INTENT_LABEL_FR[unlistedActive]}`}
            </span>
            <button
              type="button"
              onClick={() => clear(unlistedActive)}
              disabled={pending}
              className="shrink-0 font-semibold text-accent disabled:opacity-50"
            >
              {busyIntent === unlistedActive ? "…" : "Retirer"}
            </button>
          </div>
        ) : null}
      </div>

      {view.insight ? <p className="px-1 text-sm text-fg-muted">{view.insight}</p> : null}

      {why && rec ? <WhySheet recommendation={rec} onClose={() => setWhy(false)} /> : null}
    </section>
  );
}
