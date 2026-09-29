"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updatePreferencesAction } from "@/app/(app)/profile/actions";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { errorMessage, FormError, Stepper, ToggleChip } from "@/components/profile/controls";
import { MODALITY_LABEL_FR } from "@/components/profile/labels";
import { MODALITY_VALUES, type Modality } from "@/domain/core";
import type { ProfileView } from "@/server/services/profile.service";

export function PreferencesForm({
  preferences,
  weeklyHoursTarget,
}: {
  preferences: ProfileView["preferences"];
  weeklyHoursTarget: number;
}) {
  const router = useRouter();
  const [barbell, setBarbell] = useState(preferences.barbellIncrementKg);
  const [dumbbell, setDumbbell] = useState(preferences.dumbbellIncrementKg);
  const [machine, setMachine] = useState(preferences.machineIncrementKg);
  const [hard, setHard] = useState(preferences.maxHardSessionsPerWeek);
  const [hours, setHours] = useState(Math.round(weeklyHoursTarget));
  const [fav, setFav] = useState<Modality[]>(preferences.favouriteModalities);
  const [dis, setDis] = useState<Modality[]>(preferences.dislikedModalities);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function toggleFav(m: Modality) {
    setSaved(false);
    setFav((f) => (f.includes(m) ? f.filter((x) => x !== m) : [...f, m]));
    setDis((d) => d.filter((x) => x !== m));
  }
  function toggleDis(m: Modality) {
    setSaved(false);
    setDis((d) => (d.includes(m) ? d.filter((x) => x !== m) : [...d, m]));
    setFav((f) => f.filter((x) => x !== m));
  }

  function save() {
    setError(null);
    setSaved(false);
    start(async () => {
      try {
        await updatePreferencesAction({
          barbellIncrementKg: barbell,
          dumbbellIncrementKg: dumbbell,
          machineIncrementKg: machine,
          maxHardSessionsPerWeek: hard,
          weeklyHoursTarget: hours,
          favouriteModalities: fav,
          dislikedModalities: dis,
        });
        setSaved(true);
        router.refresh();
      } catch (e) {
        setError(errorMessage(e));
      }
    });
  }

  return (
    <Card>
      <CardTitle>Préférences</CardTitle>
      {!preferences.stored ? (
        <p className="mt-1 text-xs text-fg-subtle">
          Valeurs par défaut — rien n&apos;est encore enregistré.
        </p>
      ) : null}
      <div className="mt-3 flex flex-col gap-2">
        <Stepper
          label="Incrément barre"
          value={barbell}
          min={0.5}
          max={10}
          step={0.5}
          unit="kg"
          onChange={(v) => {
            setSaved(false);
            setBarbell(v);
          }}
        />
        <Stepper
          label="Incrément haltères"
          value={dumbbell}
          min={0.5}
          max={10}
          step={0.5}
          unit="kg"
          onChange={(v) => {
            setSaved(false);
            setDumbbell(v);
          }}
        />
        <Stepper
          label="Incrément machines"
          value={machine}
          min={0.5}
          max={10}
          step={0.5}
          unit="kg"
          onChange={(v) => {
            setSaved(false);
            setMachine(v);
          }}
        />
        <Stepper
          label="Séances dures max / semaine"
          value={hard}
          min={1}
          max={5}
          onChange={(v) => {
            setSaved(false);
            setHard(v);
          }}
        />
        <Stepper
          label="Heures visées / semaine"
          value={hours}
          min={1}
          max={20}
          unit="h"
          onChange={(v) => {
            setSaved(false);
            setHours(v);
          }}
        />
      </div>

      <p className="mt-4 text-xs font-semibold tracking-wide text-fg-muted uppercase">
        J&apos;aime
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {MODALITY_VALUES.map((m) => (
          <ToggleChip key={m} active={fav.includes(m)} onClick={() => toggleFav(m)}>
            {MODALITY_LABEL_FR[m]}
          </ToggleChip>
        ))}
      </div>
      <p className="mt-4 text-xs font-semibold tracking-wide text-fg-muted uppercase">
        J&apos;évite
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {MODALITY_VALUES.map((m) => (
          <ToggleChip key={m} active={dis.includes(m)} onClick={() => toggleDis(m)}>
            {MODALITY_LABEL_FR[m]}
          </ToggleChip>
        ))}
      </div>

      <FormError message={error} />
      <div className="mt-4 flex items-center gap-3">
        <Button disabled={pending} onClick={save}>
          {pending ? "…" : "Enregistrer"}
        </Button>
        {saved ? <span className="text-sm text-accent">Enregistré</span> : null}
      </div>
    </Card>
  );
}
