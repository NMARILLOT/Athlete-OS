"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { syncGarminAction, type GarminSyncActionResult } from "@/app/(app)/activities/actions";
import { Button } from "@/components/ui/button";

/**
 * "Synchroniser Garmin (<provider>)": last 14 days through the shared import pipeline. The mock is
 * named for what it is — simulated data, stored as provider `garmin_mock` (spec §14, §70).
 */
export function GarminSyncButton({ providerName }: { providerName: "mock" | "official" }) {
  const router = useRouter();
  const [result, setResult] = useState<GarminSyncActionResult | null>(null);
  const [pending, run] = useTransition();

  function sync() {
    setResult(null);
    run(async () => {
      try {
        const r = await syncGarminAction(14);
        setResult(r);
        if (r.ok) router.refresh();
      } catch {
        setResult({ ok: false, message: "Synchronisation impossible pour le moment. Réessaie." });
      }
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <Button variant="secondary" full disabled={pending} onClick={sync}>
        {pending
          ? "Synchronisation…"
          : providerName === "mock"
            ? "Synchroniser Garmin (mock — données simulées)"
            : "Synchroniser Garmin (officiel)"}
      </Button>
      {result ? (
        result.ok ? (
          <p role="status" className="text-sm text-fg-muted">
            {result.imported} activité{result.imported > 1 ? "s" : ""} importée
            {result.imported > 1 ? "s" : ""}
            {result.duplicates > 0
              ? `, ${result.duplicates} déjà connue${result.duplicates > 1 ? "s" : ""}`
              : ""}
            .
            {result.prs.length ? (
              <span className="mt-1 block font-medium text-accent">{result.prs.join(" · ")}</span>
            ) : null}
            {providerName === "mock" && result.imported > 0 ? (
              <span className="mt-1 block text-xs text-fg-subtle">
                Données simulées : aucun record ni test n&apos;est enregistré.
              </span>
            ) : null}
          </p>
        ) : (
          <p role="alert" className="text-sm text-danger">
            {result.message}
          </p>
        )
      ) : null}
    </div>
  );
}
