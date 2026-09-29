"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { logBodyCompositionAction } from "@/app/(app)/log/actions";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import type { BodyCompositionView } from "@/server/services/log.service";
import { formatDateShort, formatKg } from "@/lib/format";
import { ErrorNote, TextInput, errorMessage } from "./fields";

function toNumber(v: string): number | null {
  if (!v.trim()) return null;
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * "+ Mesure corporelle" (spec §25): weight, optional body fat / muscle / water, date-time. The
 * sparkline shows the last readings with the reminder that single readings are noisy and only
 * multi-week trends matter. Never a weight target.
 */
export function BodyForm({
  nowLocal,
  recent,
}: {
  /** "YYYY-MM-DDTHH:MM" in the athlete's timezone. */
  nowLocal: string;
  /** Newest first. */
  recent: BodyCompositionView[];
}) {
  const router = useRouter();
  const last = recent[0] ?? null;
  const [measuredLocal, setMeasuredLocal] = useState(nowLocal);
  const [weight, setWeight] = useState(last ? String(last.weightKg) : "");
  const [fat, setFat] = useState("");
  const [muscle, setMuscle] = useState("");
  const [water, setWater] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, run] = useTransition();

  const weightKg = toNumber(weight);
  const valid =
    weightKg != null &&
    weightKg >= 20 &&
    weightKg <= 300 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(measuredLocal);

  function submit() {
    if (weightKg == null) return;
    setError(null);
    setSaved(false);
    run(async () => {
      try {
        await logBodyCompositionAction({
          measuredLocal: measuredLocal.slice(0, 16),
          weightKg,
          bodyFatPct: toNumber(fat),
          muscleMassKg: toNumber(muscle),
          waterPct: toNumber(water),
        });
        setSaved(true);
        setFat("");
        setMuscle("");
        setWater("");
        router.refresh();
      } catch (e) {
        setError(errorMessage(e));
      }
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <TextInput
        label="Poids"
        type="number"
        inputMode="decimal"
        step={0.1}
        min={20}
        max={300}
        value={weight}
        onChange={setWeight}
        placeholder="kg"
      />
      <div className="grid grid-cols-3 gap-2">
        <TextInput
          label="Gras %"
          type="number"
          inputMode="decimal"
          step={0.1}
          min={1}
          max={70}
          value={fat}
          onChange={setFat}
          placeholder="—"
        />
        <TextInput
          label="Muscle kg"
          type="number"
          inputMode="decimal"
          step={0.1}
          min={5}
          max={200}
          value={muscle}
          onChange={setMuscle}
          placeholder="—"
        />
        <TextInput
          label="Eau %"
          type="number"
          inputMode="decimal"
          step={0.1}
          min={20}
          max={80}
          value={water}
          onChange={setWater}
          placeholder="—"
        />
      </div>
      <TextInput
        label="Quand"
        type="datetime-local"
        value={measuredLocal}
        onChange={setMeasuredLocal}
        max={nowLocal}
      />
      <ErrorNote message={error} />
      {saved ? (
        <p role="status" className="text-sm text-accent">
          Enregistré.
        </p>
      ) : null}
      <Button size="lg" full disabled={pending || !valid} onClick={submit}>
        {pending ? "…" : "Enregistrer la mesure"}
      </Button>

      <Card>
        <CardTitle>Dernières mesures</CardTitle>
        {recent.length ? (
          <>
            <WeightSparkline points={[...recent].reverse()} />
            <ul className="mt-3 flex flex-col gap-1 text-sm">
              {recent.map((r) => (
                <li key={r.id} className="flex justify-between text-fg-muted">
                  <span>{formatDateShort(r.localDate)}</span>
                  <span className="tabular-nums">
                    <span className="font-semibold text-fg">{formatKg(r.weightKg)}</span>
                    {r.bodyFatPct != null ? ` · ${r.bodyFatPct.toFixed(1)} %` : ""}
                    {r.muscleMassKg != null ? ` · ${formatKg(r.muscleMassKg)} muscle` : ""}
                    {r.source !== "MANUAL" ? ` · ${r.source.toLowerCase()}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="mt-2 text-sm text-fg-muted">Aucune mesure pour l&apos;instant.</p>
        )}
        <p className="mt-3 text-[11px] text-fg-subtle">
          Une mesure isolée est bruitée (hydratation, heure, repas). Seule la tendance sur plusieurs
          semaines a un sens. Utilisé pour la force relative, jamais pour fixer un objectif de
          poids.
        </p>
      </Card>
    </div>
  );
}

/** Inline SVG sparkline (no chart library): weight over the last readings, oldest → newest. */
function WeightSparkline({ points }: { points: BodyCompositionView[] }) {
  const W = 320;
  const H = 72;
  const PAD = 6;
  if (points.length < 2) {
    return (
      <p className="mt-2 text-xs text-fg-subtle">
        Une seule mesure : la courbe apparaît à partir de deux.
      </p>
    );
  }
  const values = points.map((p) => p.weightKg);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1, max - min);
  const x = (i: number) => PAD + (i / (points.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - min) / span) * (H - PAD * 2);
  const d = values
    .map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join(" ");
  const first = values[0] ?? 0;
  const lastV = values[values.length - 1] ?? 0;
  return (
    <figure className="mt-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-18 w-full"
        role="img"
        aria-label={`Poids de ${formatKg(first)} à ${formatKg(lastV)} sur ${points.length} mesures`}
      >
        <path
          d={d}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {values.map((v, i) => (
          <circle key={i} cx={x(i)} cy={y(v)} r={2.5} fill="var(--color-accent)" />
        ))}
      </svg>
      <figcaption className="flex justify-between text-[11px] text-fg-subtle">
        <span>{formatDateShort(points[0]?.localDate ?? "")}</span>
        <span>
          {formatKg(min)} – {formatKg(max)}
        </span>
        <span>{formatDateShort(points[points.length - 1]?.localDate ?? "")}</span>
      </figcaption>
    </figure>
  );
}
