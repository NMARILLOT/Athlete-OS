"use client";

import { useMemo, useState, useTransition } from "react";
import { saveAvailabilityStepAction } from "@/app/(app)/onboarding/actions";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { errorMessage, FormError, Stepper } from "@/components/profile/controls";
import { DAY_SLOTS, WEEKDAY_LABEL_FR, type DaySlotKey } from "@/components/profile/labels";
import type { AvailabilitySlotView } from "@/server/services/profile.service";
import { cn } from "@/lib/cn";

type CellKey = `${number}:${DaySlotKey}`;

function cellsFromWindows(windows: AvailabilitySlotView[]): Set<CellKey> {
  const set = new Set<CellKey>();
  for (const w of windows) {
    const slot = DAY_SLOTS.find(
      (s) => s.startMinute === w.startMinute && s.endMinute === w.endMinute,
    );
    if (slot) set.add(`${w.weekday}:${slot.key}`);
  }
  return set;
}

export function AvailabilityStep({
  weeklyHoursTarget,
  maxHardSessionsPerWeek,
  windows,
}: {
  weeklyHoursTarget: number;
  maxHardSessionsPerWeek: number;
  windows: AvailabilitySlotView[];
}) {
  const [hours, setHours] = useState(Math.min(15, Math.max(3, Math.round(weeklyHoursTarget))));
  const [hard, setHard] = useState(Math.min(4, Math.max(2, maxHardSessionsPerWeek)));
  const [cells, setCells] = useState<Set<CellKey>>(() => cellsFromWindows(windows));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const availableMinutes = useMemo(() => {
    let total = 0;
    for (const key of cells) {
      const slotKey = key.split(":")[1] as DaySlotKey;
      const slot = DAY_SLOTS.find((s) => s.key === slotKey);
      if (slot) total += slot.endMinute - slot.startMinute;
    }
    return total;
  }, [cells]);

  function toggle(weekday: number, slot: DaySlotKey) {
    const key: CellKey = `${weekday}:${slot}`;
    setCells((c) => {
      const next = new Set(c);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function submit() {
    setError(null);
    const slots = [...cells].map((key) => {
      const [wd, slotKey] = key.split(":") as [string, DaySlotKey];
      const slot = DAY_SLOTS.find((s) => s.key === slotKey);
      return {
        weekday: Number(wd),
        startMinute: slot?.startMinute ?? 0,
        endMinute: slot?.endMinute ?? 0,
      };
    });
    start(async () => {
      try {
        await saveAvailabilityStepAction({
          weeklyHoursTarget: hours,
          maxHardSessionsPerWeek: hard,
          slots,
        });
      } catch (e) {
        setError(errorMessage(e));
      }
    });
  }

  const availableHours = Math.round(availableMinutes / 60);
  const tight = cells.size > 0 && availableHours < hours;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle>Volume visé</CardTitle>
        <div className="mt-3 flex flex-col gap-2">
          <Stepper
            label="Heures par semaine"
            hint="Objectif, pas une obligation"
            value={hours}
            min={3}
            max={15}
            unit="h"
            onChange={setHours}
          />
          <Stepper
            label="Séances dures max"
            hint="Seuil, VO2, metcons intenses"
            value={hard}
            min={2}
            max={4}
            onChange={setHard}
          />
        </div>
      </Card>

      <Card>
        <CardTitle>Créneaux habituels</CardTitle>
        <p className="mt-1 text-xs text-fg-subtle">
          Coche quand tu peux t&apos;entraîner. Modifiable plus tard.
        </p>
        <div
          aria-label="Disponibilités hebdomadaires"
          className="mt-3 grid grid-cols-[2.5rem_repeat(3,1fr)] gap-1.5"
        >
          <div className="contents">
            <span className="sr-only">Jour</span>
            {DAY_SLOTS.map((s) => (
              <span
                key={s.key}
                className="pb-1 text-center text-[11px] font-semibold tracking-wide text-fg-subtle uppercase"
                title={s.hint}
              >
                {s.label}
              </span>
            ))}
          </div>
          {WEEKDAY_LABEL_FR.map((label, weekday) => (
            <div key={label} className="contents">
              <span className="flex h-11 items-center text-xs font-semibold text-fg-muted">
                {label}
              </span>
              {DAY_SLOTS.map((s) => {
                const active = cells.has(`${weekday}:${s.key}`);
                return (
                  <button
                    key={s.key}
                    type="button"
                    aria-pressed={active}
                    aria-label={`${label} ${s.label} ${s.hint}`}
                    onClick={() => toggle(weekday, s.key)}
                    className={cn(
                      "h-11 rounded-xl text-sm font-semibold transition-colors",
                      active ? "bg-accent text-accent-fg" : "bg-bg-muted/60 text-fg-subtle",
                    )}
                  >
                    {active ? "✓" : ""}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <p className={cn("mt-3 text-sm", tight ? "text-warn" : "text-fg-muted")}>
          {cells.size === 0
            ? "Aucun créneau : le moteur planifiera sans contrainte horaire."
            : `${cells.size} créneau${cells.size > 1 ? "x" : ""} · ≈ ${availableHours} h disponibles pour ${hours} h visées${tight ? " — un peu juste" : ""}`}
        </p>
      </Card>

      <FormError message={error} />
      <Button size="lg" full disabled={pending} onClick={submit}>
        {pending ? "…" : "Continuer"}
      </Button>
    </div>
  );
}
