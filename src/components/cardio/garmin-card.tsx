"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { sendToGarminAction } from "@/app/(app)/train/cardio/actions";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { formatDateShort } from "@/lib/format";
import type { CardioGarminView } from "@/server/services/cardio.service";

/**
 * SEND TO GARMIN card (spec §81): not_sent → "Envoyer vers Garmin"; pending → "En attente…";
 * synced → "✓ Séance synchronisée — programmée le …"; failed → the message + "Réessayer".
 * Flag off → disabled button with "Garmin : bientôt (API officielle en attente)", never an error.
 */
export function GarminCard({
  workoutId,
  garmin: initial,
  sendable,
}: {
  workoutId: string;
  garmin: CardioGarminView;
  /** False once the workout is done or skipped. */
  sendable: boolean;
}) {
  const router = useRouter();
  const [garmin, setGarmin] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, run] = useTransition();

  const blocked = !garmin.enabled || (garmin.providerName === "official" && !garmin.connected);
  const canSend = sendable && !blocked && !pending;

  function send() {
    setError(null);
    run(async () => {
      try {
        setGarmin(await sendToGarminAction(workoutId));
        router.refresh();
      } catch {
        setError("Envoi impossible pour le moment. La séance est conservée.");
      }
    });
  }

  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <CardTitle>Garmin</CardTitle>
        {garmin.enabled && garmin.providerName === "mock" ? <Chip tone="neutral">mock</Chip> : null}
      </div>

      {!garmin.enabled ? (
        <p className="mt-2 text-sm text-fg-muted">Garmin : bientôt (API officielle en attente).</p>
      ) : garmin.providerName === "official" && !garmin.connected ? (
        <p className="mt-2 text-sm text-fg-muted">
          Connecte ton compte Garmin (Profil → Intégrations) pour envoyer la séance.
        </p>
      ) : garmin.status === "synced" ? (
        <div className="mt-2">
          <p className="text-sm font-medium text-accent">
            ✓ Séance synchronisée
            {garmin.scheduledFor ? ` — programmée le ${formatDateShort(garmin.scheduledFor)}` : ""}
          </p>
          <p className="mt-1 text-xs text-fg-muted">
            Elle apparaît dans Garmin Connect et sur ta montre.
            {garmin.workoutId ? (
              <>
                {" "}
                <span className="font-mono text-fg-subtle">{garmin.workoutId}</span>
              </>
            ) : null}
          </p>
        </div>
      ) : garmin.status === "pending" ? (
        <p className="mt-2 text-sm text-fg-muted">
          En attente… la montre recevra la séance à la prochaine synchronisation.
        </p>
      ) : garmin.status === "failed" ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {garmin.lastError ?? "L'envoi vers Garmin a échoué."}
        </p>
      ) : (
        <p className="mt-2 text-sm text-fg-muted">
          Envoie la séance : la montre guidera chaque étape (durée, allure, zones, répétitions).
        </p>
      )}

      {garmin.status === "failed" ? (
        <Button className="mt-3" full disabled={!canSend} onClick={send}>
          {pending ? "…" : "Réessayer"}
        </Button>
      ) : garmin.status === "synced" || garmin.status === "pending" ? (
        sendable ? (
          <Button className="mt-3" full variant="outline" disabled={!canSend} onClick={send}>
            {pending ? "…" : "Renvoyer"}
          </Button>
        ) : null
      ) : (
        <Button className="mt-3" full disabled={!canSend} onClick={send}>
          {pending ? "Envoi…" : "Envoyer vers Garmin"}
        </Button>
      )}

      {!sendable && garmin.status === "not_sent" ? (
        <p className="mt-1 text-[11px] text-fg-subtle">Séance terminée : rien à envoyer.</p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
