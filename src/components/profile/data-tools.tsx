"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteAccountAction, exportDataAction } from "@/app/(app)/profile/actions";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { errorMessage, FormError } from "@/components/profile/controls";
import { clearClientCaches } from "@/components/pwa/client-cache";

const CONFIRM_WORD = "SUPPRIMER";

/** Export (JSON download via Blob) and two-step account deletion (spec §71). */
export function DataTools({ authMode }: { authMode: "local" | "supabase" }) {
  const router = useRouter();
  const [exportPending, startExport] = useTransition();
  const [exported, setExported] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [step, setStep] = useState<0 | 1>(0);
  const [word, setWord] = useState("");
  const [deletePending, startDelete] = useTransition();
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function exportNow() {
    setExportError(null);
    setExported(null);
    startExport(async () => {
      try {
        const data = await exportDataAction();
        const date = data.exportedAt.slice(0, 10);
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `athlete-os-export-${date}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        const rows = Object.values(data.tables).reduce((n, t) => n + t.length, 0);
        setExported(`${rows} lignes exportées (${Object.keys(data.tables).length} tables).`);
      } catch (e) {
        setExportError(errorMessage(e));
      }
    });
  }

  function deleteNow() {
    setDeleteError(null);
    startDelete(async () => {
      try {
        await clearClientCaches();
        await deleteAccountAction(word);
        router.replace("/login");
      } catch (e) {
        setDeleteError(errorMessage(e));
      }
    });
  }

  const canDelete = word.trim().toUpperCase() === CONFIRM_WORD;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle>Exporter</CardTitle>
        <p className="mt-2 text-sm text-fg-muted">
          Un fichier JSON avec toutes tes données : séances, séries, activités, readiness, douleurs,
          records, recommandations, objectifs… Aucun secret (jetons d&apos;intégration) n&apos;est
          inclus.
        </p>
        <Button className="mt-3" full size="lg" disabled={exportPending} onClick={exportNow}>
          {exportPending ? "Préparation…" : "Télécharger mon export"}
        </Button>
        {exported ? <p className="mt-2 text-sm text-accent">{exported}</p> : null}
        <FormError message={exportError} />
      </Card>

      <Card className="border-danger/40">
        <CardTitle className="text-danger">Supprimer mon compte</CardTitle>
        <p className="mt-2 text-sm text-fg-muted">
          Supprime définitivement toutes tes données
          {authMode === "supabase" ? " et ta session" : ""}. Aucune sauvegarde n&apos;est conservée
          : exporte d&apos;abord si tu veux garder une trace.
        </p>
        {step === 0 ? (
          <Button className="mt-3" variant="danger" size="lg" full onClick={() => setStep(1)}>
            Supprimer mon compte…
          </Button>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            <label htmlFor="confirm-delete" className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">
                Tape <span className="font-semibold text-fg">{CONFIRM_WORD}</span> pour confirmer
              </span>
              <input
                id="confirm-delete"
                type="text"
                autoCapitalize="characters"
                autoComplete="off"
                value={word}
                onChange={(e) => setWord(e.target.value)}
                className="h-12 rounded-xl border border-border bg-bg-muted/60 px-3 text-base tracking-widest uppercase"
              />
            </label>
            <div className="flex gap-2">
              <Button
                variant="danger"
                size="lg"
                className="flex-1"
                disabled={!canDelete || deletePending}
                onClick={deleteNow}
              >
                {deletePending ? "Suppression…" : "Supprimer définitivement"}
              </Button>
              <Button
                variant="ghost"
                size="lg"
                onClick={() => {
                  setStep(0);
                  setWord("");
                }}
              >
                Annuler
              </Button>
            </div>
            <FormError message={deleteError} />
          </div>
        )}
      </Card>
    </div>
  );
}
