import Link from "next/link";
import { Chip } from "@/components/ui/chip";
import { Empty } from "@/components/ui/empty";
import { formatDateShort, formatDurationSec, formatKm, formatPace } from "@/lib/format";
import type { ActivityListItem } from "@/server/services/activity.service";
import { MODALITY_EMOJI, describeComparableGroup, isSimulatedProvider } from "./labels";

/** Activities list (spec §29): measured values only, "—" when absent. */
export function ActivityList({ items }: { items: ActivityListItem[] }) {
  if (items.length === 0)
    return (
      <Empty title="Aucune activité pour l'instant">
        Importe un fichier FIT ou synchronise ta montre : la séance apparaîtra ici avec ses courbes.
      </Empty>
    );
  return (
    <ul className="flex flex-col gap-2">
      {items.map((a) => (
        <li key={a.id}>
          <Link
            href={`/activities/${a.id}`}
            className="flex items-center gap-3 rounded-2xl border border-border bg-bg-elevated p-3 transition-colors hover:bg-bg-muted"
          >
            <span aria-hidden className="text-2xl leading-none">
              {MODALITY_EMOJI[a.modality]}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{a.title}</p>
              <p className="mt-0.5 text-xs text-fg-muted tabular-nums">
                {formatDateShort(a.localDate)} · {formatDurationSec(a.durationSec)}
                {a.distanceM != null ? ` · ${formatKm(a.distanceM)}` : ""}
                {a.avgHr != null ? ` · ${a.avgHr} bpm` : ""}
                {a.avgPaceSecKm != null && a.modality === "running"
                  ? ` · ${formatPace(a.avgPaceSecKm)}`
                  : ""}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {isSimulatedProvider(a.provider) ? (
                  <Chip tone="warn" className="h-6 text-[11px]">
                    simulé
                  </Chip>
                ) : null}
                {a.comparableGroup ? (
                  <Chip tone="neutral" className="h-6 text-[11px]">
                    {describeComparableGroup(a.comparableGroup)}
                  </Chip>
                ) : null}
                {a.workoutId ? (
                  <Chip tone="accent" className="h-6 text-[11px]">
                    liée
                  </Chip>
                ) : null}
              </div>
            </div>
            <span aria-hidden className="text-fg-subtle">
              ›
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
