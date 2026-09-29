"use client";

import { useState, useTransition } from "react";
import { saveGoalsStepAction } from "@/app/(app)/onboarding/actions";
import { updateGoalsAction } from "@/app/(app)/profile/actions";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { errorMessage, FormError, ToggleChip } from "@/components/profile/controls";
import { weightWord } from "@/components/profile/labels";
import type { MediumGoalKey, ProfileGoalView } from "@/server/services/profile.service";

/**
 * Long-term goal sliders + medium-term goal chips. Used by onboarding step 1 and /profile/goals.
 * The weights are the engine's inputs as-is: no hidden normalisation.
 */
export function GoalsForm({
  long,
  medium,
  mode,
  usingDefaults,
}: {
  long: ProfileGoalView[];
  medium: ProfileGoalView[];
  mode: "onboarding" | "profile";
  usingDefaults: boolean;
}) {
  const [weights, setWeights] = useState<Record<string, number>>(
    Object.fromEntries(long.map((g) => [g.key, g.weight])),
  );
  const [selected, setSelected] = useState<MediumGoalKey[]>(
    medium.filter((g) => g.active).map((g) => g.key as MediumGoalKey),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function toggleMedium(key: MediumGoalKey) {
    setSelected((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));
  }

  function submit() {
    setError(null);
    start(async () => {
      try {
        const action = mode === "onboarding" ? saveGoalsStepAction : updateGoalsAction;
        await action({ weights, medium: selected });
      } catch (e) {
        setError(errorMessage(e));
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle>Long terme</CardTitle>
        {usingDefaults ? (
          <p className="mt-1 text-xs text-fg-subtle">
            Valeurs par défaut du moteur — ajuste-les si besoin.
          </p>
        ) : null}
        <ul className="mt-3 flex flex-col gap-4">
          {long.map((g) => {
            const v = weights[g.key] ?? g.weight;
            const id = `goal-${g.key}`;
            return (
              <li key={g.key}>
                <div className="flex items-baseline justify-between">
                  <label htmlFor={id} className="font-medium">
                    {g.title}
                  </label>
                  <span className="text-sm text-fg-muted tabular-nums">
                    {weightWord(v)} · {Math.round(v * 100)} %
                  </span>
                </div>
                <input
                  id={id}
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={v}
                  onChange={(e) => setWeights((w) => ({ ...w, [g.key]: Number(e.target.value) }))}
                  className="mt-1 h-11 w-full accent-accent"
                />
              </li>
            );
          })}
        </ul>
      </Card>

      <Card>
        <CardTitle>Moyen terme (optionnel)</CardTitle>
        <p className="mt-1 text-xs text-fg-subtle">
          Un objectif coché oriente les séances sans effacer les autres capacités.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {medium.map((g) => (
            <ToggleChip
              key={g.key}
              active={selected.includes(g.key as MediumGoalKey)}
              onClick={() => toggleMedium(g.key as MediumGoalKey)}
            >
              {g.title}
            </ToggleChip>
          ))}
        </div>
      </Card>

      <FormError message={error} />
      <Button size="lg" full disabled={pending} onClick={submit}>
        {pending ? "…" : mode === "onboarding" ? "Continuer" : "Enregistrer"}
      </Button>
    </div>
  );
}
