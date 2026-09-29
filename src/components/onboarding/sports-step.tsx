"use client";

import { useState, useTransition } from "react";
import { saveSportsStepAction } from "@/app/(app)/onboarding/actions";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { errorMessage, FormError, ToggleChip } from "@/components/profile/controls";
import {
  EQUIPMENT_LABEL_FR,
  FACILITY_LABEL_FR,
  MODALITY_LABEL_FR,
  type FacilityKey,
} from "@/components/profile/labels";
import { EQUIPMENT_VALUES, MODALITY_VALUES, type Equipment, type Modality } from "@/domain/core";

/** Typical equipment per facility, added (never removed) when a facility is switched on. */
const FACILITY_EQUIPMENT: Record<FacilityKey, Equipment[]> = {
  crossfitBox: [
    "barbell",
    "rack",
    "bench",
    "pull_up_bar",
    "rings",
    "dumbbell",
    "kettlebell",
    "rower",
    "bike_erg",
    "ski_erg",
    "assault_bike",
    "wall_ball",
    "box",
    "jump_rope",
    "ghd",
    "sled",
    "sandbag",
    "bodyweight",
  ],
  gym: ["barbell", "rack", "bench", "dumbbell", "machine", "cable", "pull_up_bar", "treadmill"],
  home: ["dumbbell", "kettlebell", "pull_up_bar", "jump_rope", "bodyweight", "outdoor"],
};

const TIME_FAMILIES = [
  { key: "crossfit", label: "CrossFit (cours)" },
  { key: "strength", label: "Musculation" },
  { key: "cardio", label: "Cardio" },
] as const;

export function SportsStep({
  favouriteModalities,
  facilities,
  equipment,
  preferredTrainingTimes,
}: {
  favouriteModalities: Modality[];
  facilities: Partial<Record<FacilityKey, boolean>>;
  equipment: Equipment[];
  preferredTrainingTimes: Partial<Record<"crossfit" | "strength" | "cardio", string>>;
}) {
  const [fav, setFav] = useState<Modality[]>(favouriteModalities);
  const [fac, setFac] = useState<Record<FacilityKey, boolean>>({
    crossfitBox: Boolean(facilities.crossfitBox),
    gym: Boolean(facilities.gym),
    home: Boolean(facilities.home),
  });
  const [eq, setEq] = useState<Equipment[]>(equipment);
  const [times, setTimes] = useState<Record<"crossfit" | "strength" | "cardio", string>>({
    crossfit: preferredTrainingTimes.crossfit ?? "",
    strength: preferredTrainingTimes.strength ?? "",
    cardio: preferredTrainingTimes.cardio ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function toggleFacility(key: FacilityKey) {
    const next = !fac[key];
    setFac((f) => ({ ...f, [key]: next }));
    if (next) setEq((e) => [...new Set([...e, ...FACILITY_EQUIPMENT[key]])]);
  }
  function toggleIn<T>(list: T[], v: T): T[] {
    return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  }

  function submit() {
    setError(null);
    start(async () => {
      try {
        await saveSportsStepAction({
          favouriteModalities: fav,
          facilities: fac,
          equipment: eq,
          preferredTrainingTimes: {
            crossfit: times.crossfit || null,
            strength: times.strength || null,
            cardio: times.cardio || null,
          },
        });
      } catch (e) {
        setError(errorMessage(e));
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle>Ce que tu aimes</CardTitle>
        <div className="mt-3 flex flex-wrap gap-2">
          {MODALITY_VALUES.map((m) => (
            <ToggleChip key={m} active={fav.includes(m)} onClick={() => setFav(toggleIn(fav, m))}>
              {MODALITY_LABEL_FR[m]}
            </ToggleChip>
          ))}
        </div>
      </Card>

      <Card>
        <CardTitle>Où tu t&apos;entraînes</CardTitle>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {(Object.keys(FACILITY_LABEL_FR) as FacilityKey[]).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={fac[k]}
              onClick={() => toggleFacility(k)}
              className={
                fac[k]
                  ? "h-14 rounded-2xl bg-accent text-base font-semibold text-accent-fg"
                  : "h-14 rounded-2xl bg-bg-muted text-base font-semibold text-fg-muted"
              }
            >
              {FACILITY_LABEL_FR[k]}
            </button>
          ))}
        </div>
      </Card>

      <Card>
        <CardTitle>Matériel disponible</CardTitle>
        <p className="mt-1 text-xs text-fg-subtle">
          Le moteur ne proposera que des séances faisables avec ce matériel.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {EQUIPMENT_VALUES.map((e) => (
            <ToggleChip key={e} active={eq.includes(e)} onClick={() => setEq(toggleIn(eq, e))}>
              {EQUIPMENT_LABEL_FR[e]}
            </ToggleChip>
          ))}
        </div>
      </Card>

      <Card>
        <CardTitle>Heures habituelles</CardTitle>
        <p className="mt-1 text-xs text-fg-subtle">
          Optionnel — sert d&apos;heure par défaut quand tu planifies une séance.
        </p>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {TIME_FAMILIES.map((f) => (
            <label key={f.key} htmlFor={`time-${f.key}`} className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">{f.label}</span>
              <input
                id={`time-${f.key}`}
                type="time"
                value={times[f.key]}
                onChange={(e) => setTimes((t) => ({ ...t, [f.key]: e.target.value }))}
                className="h-12 rounded-xl border border-border bg-bg-muted/60 px-2 text-sm"
              />
            </label>
          ))}
        </div>
      </Card>

      <FormError message={error} />
      <Button size="lg" full disabled={pending} onClick={submit}>
        {pending ? "…" : "Continuer"}
      </Button>
    </div>
  );
}
