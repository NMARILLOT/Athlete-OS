"use client";

import { useState, useTransition } from "react";
import { saveLevelStepAction } from "@/app/(app)/onboarding/actions";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { errorMessage, FormError, NumberField } from "@/components/profile/controls";
import { PR_LIFT_LABEL_FR } from "@/components/profile/labels";
import type { DeclaredPrView } from "@/server/services/profile.service";

type Lift =
  "back_squat" | "front_squat" | "deadlift" | "bench_press" | "strict_press" | "clean" | "snatch";

function num(s: string): number | null {
  if (s.trim() === "") return null;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export function LevelStep({
  lifts,
  declaredPrs,
  lthrManual,
  maxHrManual,
  restingHrManual,
  bodyweightKg,
}: {
  lifts: readonly Lift[];
  declaredPrs: DeclaredPrView[];
  lthrManual: number | null;
  maxHrManual: number | null;
  restingHrManual: number | null;
  bodyweightKg: number | null;
}) {
  const [prs, setPrs] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      lifts.map((l) => [l, String(declaredPrs.find((p) => p.exerciseId === l)?.valueKg ?? "")]),
    ),
  );
  const [lthr, setLthr] = useState(lthrManual != null ? String(lthrManual) : "");
  const [maxHr, setMaxHr] = useState(maxHrManual != null ? String(maxHrManual) : "");
  const [rhr, setRhr] = useState(restingHrManual != null ? String(restingHrManual) : "");
  const [bw, setBw] = useState(bodyweightKg != null ? String(bodyweightKg) : "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit() {
    setError(null);
    const declared: Array<{ exerciseId: Lift; weightKg: number }> = [];
    for (const l of lifts) {
      const v = num(prs[l] ?? "");
      if (v != null && v > 0) declared.push({ exerciseId: l, weightKg: v });
    }
    const intOrNull = (s: string) => {
      const v = num(s);
      return v == null ? null : Math.round(v);
    };
    start(async () => {
      try {
        await saveLevelStepAction({
          prs: declared,
          lthrManual: intOrNull(lthr),
          maxHrManual: intOrNull(maxHr),
          restingHrManual: intOrNull(rhr),
          bodyweightKg: num(bw),
        });
      } catch (e) {
        setError(errorMessage(e));
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle>1RM déclarés (kg)</CardTitle>
        <p className="mt-1 text-xs text-fg-subtle">
          Optionnel. Ces valeurs servent de point de départ à l&apos;autoload ; elles seront
          remplacées par tes séances réelles.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {lifts.map((l) => (
            <NumberField
              key={l}
              id={`pr-${l}`}
              label={PR_LIFT_LABEL_FR[l] ?? l}
              unit="kg"
              step="2.5"
              value={prs[l] ?? ""}
              onChange={(v) => setPrs((p) => ({ ...p, [l]: v }))}
            />
          ))}
        </div>
      </Card>

      <Card>
        <CardTitle>Cardio & corps</CardTitle>
        <p className="mt-1 text-xs text-fg-subtle">
          Si tu les connais. Sinon, laisse vide : rien ne sera inventé.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <NumberField
            id="lthr"
            label="LTHR"
            unit="bpm"
            step="1"
            value={lthr}
            onChange={setLthr}
            hint="FC au seuil lactique"
          />
          <NumberField
            id="maxhr"
            label="FC max"
            unit="bpm"
            step="1"
            value={maxHr}
            onChange={setMaxHr}
          />
          <NumberField
            id="rhr"
            label="FC repos"
            unit="bpm"
            step="1"
            value={rhr}
            onChange={setRhr}
          />
          <NumberField id="bw" label="Poids" unit="kg" step="0.1" value={bw} onChange={setBw} />
        </div>
      </Card>

      <FormError message={error} />
      <Button size="lg" full disabled={pending} onClick={submit}>
        {pending ? "…" : "Continuer"}
      </Button>
    </div>
  );
}
