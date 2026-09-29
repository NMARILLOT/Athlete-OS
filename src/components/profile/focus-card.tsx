"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { endDeloadAction, setFocusAction, startDeloadAction } from "@/app/(app)/profile/actions";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { errorMessage, FormError, ToggleChip } from "@/components/profile/controls";
import { BLOCK_FOCUS_HINT_FR, BLOCK_FOCUS_LABEL_FR } from "@/components/profile/labels";
import type { ProfileBlockView } from "@/server/services/profile.service";
import { formatDateShort } from "@/lib/format";

type Focus = "base" | "build" | "performance" | "custom";
const FOCUS_OPTIONS: Focus[] = ["base", "build", "performance", "custom"];
const DELOAD_REASONS = [
  "Fatigue accumulée",
  "Douleur",
  "Stagnation",
  "Semaine chargée",
  "Préventif",
] as const;
const DELOAD_DAYS = 7;

/** CURRENT FOCUS (spec §36) + deload state (spec §42). Never "Jour X/90": blocks have no rigid length. */
export function FocusCard({
  block,
  deload,
  baselinePhase,
  baselinePhaseUntil,
}: {
  block: ProfileBlockView | null;
  deload: ProfileBlockView | null;
  baselinePhase: boolean;
  baselinePhaseUntil: string | null;
}) {
  const router = useRouter();
  const [editingFocus, setEditingFocus] = useState(false);
  const [focus, setFocus] = useState<Focus>(
    block && block.focus !== "recovery" ? (block.focus as Focus) : "custom",
  );
  const [askingDeload, setAskingDeload] = useState(false);
  const [reason, setReason] = useState<string>(DELOAD_REASONS[0]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function run(fn: () => Promise<void>, after?: () => void) {
    setError(null);
    start(async () => {
      try {
        await fn();
        after?.();
        router.refresh();
      } catch (e) {
        setError(errorMessage(e));
      }
    });
  }

  return (
    <Card>
      <CardTitle>Current focus</CardTitle>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {block ? (
          <>
            <Chip tone="accent">{BLOCK_FOCUS_LABEL_FR[block.focus]}</Chip>
            <span className="text-sm text-fg-muted">
              {block.name} · depuis le {formatDateShort(block.startsOn)}
              {block.source === "ENGINE" ? " · proposé par le moteur" : ""}
            </span>
          </>
        ) : (
          <span className="text-sm text-fg-muted">
            Aucun bloc : le moteur suit tes objectifs tels quels.
          </span>
        )}
        {baselinePhase ? (
          <Chip tone="info">
            Athlete OS apprend ton profil
            {baselinePhaseUntil ? ` · jusqu'au ${formatDateShort(baselinePhaseUntil)}` : ""}
          </Chip>
        ) : null}
      </div>

      {editingFocus ? (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {FOCUS_OPTIONS.map((f) => (
              <ToggleChip key={f} active={focus === f} onClick={() => setFocus(f)}>
                {BLOCK_FOCUS_LABEL_FR[f]}
              </ToggleChip>
            ))}
          </div>
          <p className="text-xs text-fg-subtle">{BLOCK_FOCUS_HINT_FR[focus]}</p>
          <div className="flex gap-2">
            <Button
              disabled={pending}
              onClick={() =>
                run(
                  () => setFocusAction({ focus, name: "" }),
                  () => setEditingFocus(false),
                )
              }
            >
              {pending ? "…" : "Appliquer"}
            </Button>
            <Button variant="ghost" onClick={() => setEditingFocus(false)}>
              Annuler
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEditingFocus(true)}
          className="mt-3 flex min-h-11 items-center text-sm font-semibold text-accent"
        >
          Changer de focus
        </button>
      )}

      <div className="mt-4 border-t border-border pt-3">
        {deload ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone="recovery">Deload en cours</Chip>
              <span className="text-sm text-fg-muted">
                {deload.endsOn ? `jusqu'au ${formatDateShort(deload.endsOn)}` : "sans date de fin"}
                {deload.source === "ENGINE" ? " · déclenché par le moteur" : ""}
              </span>
            </div>
            {deload.reason ? (
              <p className="text-sm text-fg-muted">Raison : {deload.reason}</p>
            ) : null}
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => run(() => endDeloadAction())}
            >
              {pending ? "…" : "Terminer le deload"}
            </Button>
          </div>
        ) : askingDeload ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-fg-muted">
              {DELOAD_DAYS} jours plus légers : volume et intensité réduits, pas forcément rien.
            </p>
            <div className="flex flex-wrap gap-2">
              {DELOAD_REASONS.map((r) => (
                <ToggleChip key={r} active={reason === r} onClick={() => setReason(r)}>
                  {r}
                </ToggleChip>
              ))}
            </div>
            <div className="flex gap-2">
              <Button
                disabled={pending}
                onClick={() =>
                  run(
                    () => startDeloadAction({ days: DELOAD_DAYS, reason }),
                    () => setAskingDeload(false),
                  )
                }
              >
                {pending ? "…" : "Confirmer"}
              </Button>
              <Button variant="ghost" onClick={() => setAskingDeload(false)}>
                Annuler
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="secondary" onClick={() => setAskingDeload(true)}>
            Démarrer un deload ({DELOAD_DAYS} j)
          </Button>
        )}
      </div>
      <FormError message={error} />
    </Card>
  );
}
