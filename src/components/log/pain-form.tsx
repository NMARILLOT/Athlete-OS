"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { logPainAction, resolvePainAction } from "@/app/(app)/log/actions";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { PAIN_LOCATION_VALUES, type PainLocation } from "@/domain/core";
import type { ActivePainView } from "@/server/services/log.service";
import { cn } from "@/lib/cn";
import { formatDateShort } from "@/lib/format";
import { ErrorNote, Field, Segmented, Slider, TextInput, Toggle, errorMessage } from "./fields";

export const PAIN_LOCATION_FR: Record<PainLocation, string> = {
  neck: "Cou",
  shoulder: "Épaule",
  elbow: "Coude",
  wrist: "Poignet",
  upper_back: "Haut du dos",
  lower_back: "Bas du dos",
  hip: "Hanche",
  groin: "Aine",
  knee: "Genou",
  shin: "Tibia",
  calf: "Mollet",
  achilles: "Tendon d'Achille",
  ankle: "Cheville",
  foot: "Pied",
  hamstring: "Ischio",
  quad: "Quadriceps",
  other: "Autre",
};

type Side = "left" | "right" | "both" | "none";
const SIDES: ReadonlyArray<{ value: Side; label: string }> = [
  { value: "left", label: "Gauche" },
  { value: "right", label: "Droite" },
  { value: "both", label: "Les deux" },
  { value: "none", label: "—" },
];

/**
 * "+ Signaler une douleur" (spec §91–95): location, side, 0–10, movement-specific, sudden,
 * persistent. No diagnosis: the engine reduces or replaces loads; a calm message suggests a
 * consultation when the service says so.
 */
export function PainForm({ active }: { active: ActivePainView[] }) {
  const router = useRouter();
  const [location, setLocation] = useState<PainLocation | null>(null);
  const [side, setSide] = useState<Side>("none");
  const [intensity, setIntensity] = useState(3);
  const [movementSpecific, setMovementSpecific] = useState(false);
  const [movements, setMovements] = useState("");
  const [sudden, setSudden] = useState(false);
  const [persistent, setPersistent] = useState(false);
  const [notes, setNotes] = useState("");
  const [result, setResult] = useState<{ medicalAdvice: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, run] = useTransition();
  const [resolving, setResolving] = useState<string | null>(null);

  function submit() {
    if (!location) return;
    setError(null);
    run(async () => {
      try {
        const res = await logPainAction({
          location,
          side: side === "none" ? null : side,
          intensity,
          movementSpecific,
          movements: movements
            .split(",")
            .map((m) => m.trim())
            .filter(Boolean)
            .slice(0, 12),
          sudden,
          persistent,
          notes: notes.trim() || undefined,
        });
        setResult({ medicalAdvice: res.medicalAdvice });
        setLocation(null);
        setSide("none");
        setIntensity(3);
        setMovementSpecific(false);
        setMovements("");
        setSudden(false);
        setPersistent(false);
        setNotes("");
        router.refresh();
      } catch (e) {
        setError(errorMessage(e));
      }
    });
  }

  function resolve(id: string) {
    setResolving(id);
    run(async () => {
      try {
        await resolvePainAction(id);
        router.refresh();
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setResolving(null);
      }
    });
  }

  return (
    <div className="flex flex-col gap-5">
      {result ? (
        <div
          role="status"
          className={cn(
            "rounded-2xl px-4 py-3 text-sm",
            result.medicalAdvice ? "bg-warn/10 text-fg" : "bg-accent/10 text-fg",
          )}
        >
          {result.medicalAdvice ? (
            <>
              <p className="font-semibold">C&apos;est noté.</p>
              <p className="mt-1 text-fg-muted">
                Une douleur forte, soudaine ou qui dure mérite l&apos;avis d&apos;un professionnel
                de santé. Athlete OS ne pose pas de diagnostic : en attendant, le plan réduit ou
                remplace ce qui sollicite cette zone.
              </p>
            </>
          ) : (
            <>
              <p className="font-semibold">C&apos;est noté.</p>
              <p className="mt-1 text-fg-muted">
                Le moteur en tient compte : moins de charge sur cette zone, et des alternatives si
                besoin.
              </p>
            </>
          )}
        </div>
      ) : null}

      <Field label="Où ?">
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Localisation">
          {PAIN_LOCATION_VALUES.map((loc) => (
            <button
              key={loc}
              type="button"
              role="radio"
              aria-checked={location === loc}
              onClick={() => setLocation(loc)}
              className={cn(
                "h-11 rounded-full px-3.5 text-sm font-semibold",
                location === loc ? "bg-accent text-accent-fg" : "bg-bg-muted text-fg-muted",
              )}
            >
              {PAIN_LOCATION_FR[loc]}
            </button>
          ))}
        </div>
      </Field>
      <Segmented label="Côté" value={side} options={SIDES} onChange={setSide} columns={4} />
      <Slider
        label="Intensité"
        value={intensity}
        onChange={setIntensity}
        min={0}
        max={10}
        display={(v) => `${v}/10`}
      />
      <Toggle
        label="Liée à un mouvement précis ?"
        value={movementSpecific}
        onChange={setMovementSpecific}
      />
      {movementSpecific ? (
        <TextInput
          label="Mouvements"
          value={movements}
          onChange={setMovements}
          placeholder="ex. squat, overhead, course"
          hint="Sépare par des virgules."
        />
      ) : null}
      <Toggle label="Apparue soudainement ?" value={sudden} onChange={setSudden} />
      <Toggle label="Dure depuis plusieurs jours ?" value={persistent} onChange={setPersistent} />
      <TextInput label="Notes" value={notes} onChange={setNotes} placeholder="optionnel" />
      <ErrorNote message={error} />
      <Button size="lg" full disabled={pending || !location} onClick={submit}>
        {pending && !resolving ? "…" : "Signaler"}
      </Button>

      {active.length ? (
        <Card>
          <CardTitle>Douleurs en cours</CardTitle>
          <ul className="mt-2 flex flex-col gap-2">
            {active.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">
                    {PAIN_LOCATION_FR[p.location]}
                    {p.side
                      ? ` · ${p.side === "left" ? "gauche" : p.side === "right" ? "droite" : "les deux"}`
                      : ""}
                    {" · "}
                    {p.intensity}/10
                  </p>
                  <p className="truncate text-xs text-fg-muted">
                    {formatDateShort(p.reportedAt.slice(0, 10))}
                    {p.movements.length ? ` · ${p.movements.join(", ")}` : ""}
                    {p.sudden ? " · soudaine" : ""}
                    {p.persistent ? " · persistante" : ""}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => resolve(p.id)}
                >
                  {resolving === p.id ? "…" : "Résolue"}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
