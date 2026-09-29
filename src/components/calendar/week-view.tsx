import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Card, CardTitle } from "@/components/ui/card";
import { Chip, toneFor } from "@/components/ui/chip";
import { Stat } from "@/components/ui/stat";
import { addDays, isoWeekStart } from "@/domain/core/dates";
import { confidenceLabel } from "@/domain/engine";
import type { Confidence, IntensityBand, WorkoutStatus } from "@/domain/core";
import { cn } from "@/lib/cn";
import { clockFromMinutes, formatDateShort, formatMinutes } from "@/lib/format";
import type { CalendarDay, CalendarWeek, WeekSummary } from "@/server/services/calendar.service";
import type { CalendarDayView, WorkoutCard } from "@/server/services/view-models";
import { MoveButton } from "./move-sheet";
import { RestQuickAction } from "./rest-quick-action";

type Tone = ReturnType<typeof toneFor>;

/** Static class names so Tailwind can see them (left border colour = session type, spec §53). */
const BORDER: Record<Tone, string> = {
  neutral: "border-l-border-strong",
  accent: "border-l-accent",
  crossfit: "border-l-crossfit",
  strength: "border-l-strength",
  cardioEasy: "border-l-cardio-easy",
  cardioHard: "border-l-cardio-hard",
  recovery: "border-l-recovery",
  coaching: "border-l-coaching",
  warn: "border-l-warn",
  danger: "border-l-danger",
  info: "border-l-info",
};

const STATUS_FR: Record<WorkoutStatus, string> = {
  planned: "Prévu",
  in_progress: "En cours",
  done: "Fait",
  skipped: "Sauté",
  auto_adjusted: "Replanifié",
};
const STATUS_CLASS: Record<WorkoutStatus, string> = {
  planned: "text-fg-muted",
  in_progress: "text-warn",
  done: "text-accent",
  skipped: "text-fg-subtle",
  auto_adjusted: "text-info",
};
const INTENSITY_FR: Record<IntensityBand, string> = {
  easy: "facile",
  moderate: "modérée",
  hard: "dure",
};

/** "28 sept." from an ISO date (weekday dropped). */
function dayMonth(iso: string): string {
  return formatDateShort(iso).split(" ").slice(1).join(" ");
}

export function WeekView({ week }: { week: CalendarWeek }) {
  const currentWeekStart = isoWeekStart(week.today);
  return (
    <div className="flex flex-col gap-4">
      <WeekStrip weekStart={week.weekStart} currentWeekStart={currentWeekStart} />
      <WeekSummaryCard summary={week.summary} past={week.weekStart < currentWeekStart} />
      <ol className="flex flex-col gap-3">
        {week.days.map((day) => (
          <li key={day.date}>
            <DayCard day={day} today={week.today} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function WeekStrip({
  weekStart,
  currentWeekStart,
}: {
  weekStart: string;
  currentWeekStart: string;
}) {
  const isCurrent = weekStart === currentWeekStart;
  const navClass =
    "flex size-11 shrink-0 items-center justify-center rounded-xl bg-bg-muted text-fg-muted hover:text-fg";
  return (
    <nav aria-label="Changer de semaine" className="flex items-center gap-2">
      <Link
        href={`/calendar?week=${addDays(weekStart, -7)}`}
        aria-label="Semaine précédente"
        className={navClass}
      >
        <ChevronLeft className="size-6" aria-hidden />
      </Link>
      <div className="min-w-0 flex-1 text-center">
        <p className="truncate font-semibold">
          Semaine du {dayMonth(weekStart)} au {dayMonth(addDays(weekStart, 6))}
        </p>
        {isCurrent ? (
          <p className="text-xs text-fg-muted">Cette semaine</p>
        ) : (
          <Link href="/calendar" className="text-xs font-semibold text-accent">
            Aujourd&apos;hui
          </Link>
        )}
      </div>
      <Link
        href={`/calendar?week=${addDays(weekStart, 7)}`}
        aria-label="Semaine suivante"
        className={navClass}
      >
        <ChevronRight className="size-6" aria-hidden />
      </Link>
    </nav>
  );
}

function WeekSummaryCard({ summary, past }: { summary: WeekSummary; past: boolean }) {
  const hard = summary.hard;
  return (
    <Card>
      <div className="flex items-center justify-between">
        <CardTitle>{past ? "Bilan de la semaine" : "Cette semaine"}</CardTitle>
        {summary.deloadActive ? <Chip tone="recovery">Deload actif</Chip> : null}
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <Stat
          label="Séances dures"
          value={hard ? `${hard.done}/${hard.max}` : null}
          hint={
            hard
              ? hard.fixedUpcoming > 0
                ? `6 derniers jours · +${hard.fixedUpcoming} cours fixé`
                : "6 derniers jours"
              : "hors semaine en cours"
          }
        />
        <Stat
          label="Faites"
          value={summary.done}
          hint={`${summary.planned} à venir · ${summary.skipped} sautée${summary.skipped > 1 ? "s" : ""}`}
        />
        <Stat
          label="Minutes"
          value={summary.doneMinutes > 0 ? formatMinutes(summary.doneMinutes) : "0 min"}
          hint="séances faites"
        />
      </div>
      {summary.topGaps.length ? (
        <div className="mt-3">
          <p className="text-[11px] font-medium tracking-wide text-fg-subtle uppercase">
            Manques principaux
          </p>
          <div className="mt-1 flex flex-wrap gap-2">
            {summary.topGaps.map((g) => (
              <Chip key={g.key} tone="warn">
                {g.label} · −{g.projectedGap}
              </Chip>
            ))}
          </div>
        </div>
      ) : summary.engineDate ? (
        <p className="mt-3 text-xs text-fg-muted">Aucun manque projeté cette semaine.</p>
      ) : null}
    </Card>
  );
}

function DayCard({ day, today }: { day: CalendarDay; today: string }) {
  const future = day.date >= today;
  const empty = day.workouts.length === 0 && !day.outlook && !day.bonus;
  return (
    <Card className={cn(day.isToday && "border-accent/50", day.isPast && "opacity-80")}>
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-semibold capitalize">{formatDateShort(day.date)}</h2>
        {day.isToday ? <Chip tone="accent">Aujourd&apos;hui</Chip> : null}
      </header>
      {day.workouts.length ? (
        <ul className="mt-2 flex flex-col gap-2">
          {day.workouts.map((w) => (
            <li key={w.id}>
              <WorkoutRow card={w} today={today} />
            </li>
          ))}
        </ul>
      ) : null}
      {day.outlook ? (
        <ProjectedRow
          outlook={day.outlook}
          explanation={day.outlookExplanation}
          confidence={day.outlookConfidence}
        />
      ) : null}
      {day.bonus ? (
        <p className="mt-2 text-xs text-fg-muted">+ bonus proposé : {day.bonus.title}</p>
      ) : null}
      {empty && !future ? (
        <p className="mt-2 text-sm text-fg-subtle">Rien d&apos;enregistré.</p>
      ) : null}
      {future ? <AddRow date={day.date} /> : null}
    </Card>
  );
}

function WorkoutRow({ card, today }: { card: WorkoutCard; today: string }) {
  const tone = toneFor(
    card.type === "cardio" ? (card.kind ?? "cardio") : card.type,
    card.intensity,
  );
  const movable =
    !card.fixed &&
    (card.status === "planned" || card.status === "auto_adjusted") &&
    card.date >= today;
  return (
    <div className="flex items-stretch gap-2">
      <Link
        href={`/workouts/${card.id}`}
        className={cn(
          "flex min-h-14 min-w-0 flex-1 flex-col justify-center rounded-xl border border-l-4 border-border bg-bg-muted/40 px-3 py-2",
          BORDER[tone],
          card.status === "skipped" && "opacity-60",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-medium">{card.title}</span>
          <span className={cn("shrink-0 text-xs font-semibold", STATUS_CLASS[card.status])}>
            {STATUS_FR[card.status]}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
          {card.startMinute != null ? <span>{clockFromMinutes(card.startMinute)}</span> : null}
          {card.durationMin != null ? <span>{formatMinutes(card.durationMin)}</span> : null}
          {card.intensity ? (
            <Chip tone={tone} className="h-5 px-2 text-[11px]">
              {INTENSITY_FR[card.intensity]}
            </Chip>
          ) : null}
          {card.fixed ? (
            <Chip tone="coaching" className="h-5 px-2 text-[11px]">
              fixé
            </Chip>
          ) : null}
          {card.rpe != null ? <span>RPE {card.rpe}</span> : null}
        </div>
      </Link>
      {movable ? (
        <MoveButton workoutId={card.id} title={card.title} fromDate={card.date} today={today} />
      ) : null}
    </div>
  );
}

/** Engine projection: dimmed, "proposé", the one-line explanation opens on tap (no JS needed). */
function ProjectedRow({
  outlook,
  explanation,
  confidence,
}: {
  outlook: NonNullable<CalendarDayView["outlook"]>;
  explanation: string | null;
  confidence: Confidence | null;
}) {
  const tone = toneFor(outlook.family, outlook.intensity);
  return (
    <details
      className={cn(
        "mt-2 rounded-xl border border-l-4 border-dashed border-border bg-bg-muted/20 px-3 py-2 opacity-70 open:opacity-100",
        BORDER[tone],
      )}
    >
      <summary className="min-h-10 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-medium text-fg-muted">{outlook.title}</span>
          <Chip tone="neutral" className="h-5 shrink-0 px-2 text-[11px]">
            proposé
          </Chip>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-fg-subtle">
          <span>≈ {formatMinutes(outlook.durationMin)}</span>
          <Chip tone={tone} className="h-5 px-2 text-[11px]">
            {INTENSITY_FR[outlook.intensity]}
          </Chip>
          {confidence ? <span>{confidenceLabel(confidence)}</span> : null}
        </div>
      </summary>
      <p className="mt-2 text-sm text-fg-muted">
        {explanation ?? "Projection du moteur, sans explication disponible."}
      </p>
    </details>
  );
}

/** "+" row on future days: WOD, cardio, and the rest quick action. */
function AddRow({ date }: { date: string }) {
  const linkClass =
    "flex h-11 flex-1 items-center justify-center rounded-xl bg-bg-muted text-sm font-semibold";
  return (
    <div className="mt-3 flex items-center gap-2">
      <Link href={`/inbox/new?for=${date}`} className={cn(linkClass, "text-crossfit")}>
        + WOD
      </Link>
      <Link href={`/train/cardio/new?date=${date}`} className={cn(linkClass, "text-cardio-easy")}>
        + Cardio
      </Link>
      <RestQuickAction date={date} />
    </div>
  );
}
