"use client";

import { useState, useTransition } from "react";
import { logCoachSessionAction } from "@/app/(app)/log/actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { ErrorNote, Field, Segmented, Stepper, TextInput, errorMessage } from "./fields";

type DemoLevel = "none" | "light" | "moderate" | "heavy";
const DEMO: ReadonlyArray<{ value: DemoLevel; label: string }> = [
  { value: "none", label: "Aucune" },
  { value: "light", label: "Légère" },
  { value: "moderate", label: "Modérée" },
  { value: "heavy", label: "Importante" },
];

/** "+ Coaching CrossFit" (spec §24): time, duration, demo level, standing minutes, felt fatigue. */
export function CoachForm({ today, defaultStart }: { today: string; defaultStart: string }) {
  const [date, setDate] = useState(today);
  const [start, setStart] = useState(defaultStart);
  const [durationMin, setDurationMin] = useState(60);
  const [demoLevel, setDemoLevel] = useState<DemoLevel>("light");
  const [standingMinutes, setStandingMinutes] = useState(60);
  const [standingTouched, setStandingTouched] = useState(false);
  const [fatigue, setFatigue] = useState(2);
  const [error, setError] = useState<string | null>(null);
  const [pending, run] = useTransition();

  function setDuration(v: number) {
    setDurationMin(v);
    if (!standingTouched) setStandingMinutes(v);
  }

  function submit() {
    setError(null);
    run(async () => {
      try {
        await logCoachSessionAction({
          date,
          start: /^\d{2}:\d{2}$/.test(start) ? start : null,
          durationMin,
          demoLevel,
          standingMinutes,
          perceivedFatigue: fatigue,
        });
      } catch (e) {
        setError(errorMessage(e));
      }
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-2">
        <TextInput label="Date" type="date" value={date} onChange={setDate} max={today} />
        <TextInput label="Heure" type="time" value={start} onChange={setStart} />
      </div>
      <Stepper
        label="Durée"
        value={durationMin}
        onChange={setDuration}
        step={15}
        min={15}
        max={600}
      />
      <Segmented
        label="Démonstrations physiques"
        value={demoLevel}
        options={DEMO}
        onChange={setDemoLevel}
        columns={4}
      />
      <Stepper
        label="Minutes debout"
        value={standingMinutes}
        onChange={(v) => {
          setStandingTouched(true);
          setStandingMinutes(v);
        }}
        step={15}
        min={0}
        max={600}
      />
      <Field label="Fatigue ressentie" hint="1 = rien senti · 5 = rincé">
        <div className="grid grid-cols-5 gap-1.5" role="radiogroup" aria-label="Fatigue ressentie">
          {[1, 2, 3, 4, 5].map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={fatigue === v}
              onClick={() => setFatigue(v)}
              className={cn(
                "h-14 rounded-2xl text-xl font-semibold",
                fatigue === v ? "bg-accent text-accent-fg" : "bg-bg-muted text-fg-muted",
              )}
            >
              {v}
            </button>
          ))}
        </div>
      </Field>
      <p className="text-xs text-fg-subtle">
        Pas une séance : compte seulement comme fatigue dans le contexte de récupération.
      </p>
      <ErrorNote message={error} />
      <Button size="lg" full disabled={pending} onClick={submit}>
        {pending ? "…" : "Enregistrer le coaching"}
      </Button>
    </div>
  );
}
