"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type DragEvent } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";

type State =
  | { kind: "idle" }
  | { kind: "uploading"; name: string }
  | {
      kind: "done";
      activityId: string;
      workoutId: string | null;
      duplicate: boolean;
      warnings: string[];
      prs: string[];
    }
  | { kind: "error"; message: string };

interface ImportResponse {
  activityId?: string;
  workoutId?: string | null;
  duplicate?: boolean;
  warnings?: string[];
  prs?: string[];
  error?: string;
}

const MAX_BYTES = 25 * 1024 * 1024;

/** FIT upload (file picker or drag-and-drop) → POST /api/import/fit → the activity page. */
export function FitImportForm() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);

  async function upload(file: File) {
    if (!/\.fit$/i.test(file.name)) {
      setState({ kind: "error", message: "Choisis un fichier .fit (export Garmin Connect)." });
      return;
    }
    if (file.size > MAX_BYTES) {
      setState({ kind: "error", message: "Fichier trop volumineux (25 Mo max)." });
      return;
    }
    setState({ kind: "uploading", name: file.name });
    const body = new FormData();
    body.append("file", file, file.name);
    try {
      const res = await fetch("/api/import/fit", { method: "POST", body });
      const json = (await res.json().catch(() => ({}))) as ImportResponse;
      if (!res.ok || !json.activityId) {
        setState({
          kind: "error",
          message:
            res.status === 401
              ? "Session expirée : reconnecte-toi puis réessaie."
              : (json.error ?? "Import impossible pour le moment."),
        });
        return;
      }
      const done: State = {
        kind: "done",
        activityId: json.activityId,
        workoutId: json.workoutId ?? null,
        duplicate: Boolean(json.duplicate),
        warnings: json.warnings ?? [],
        prs: json.prs ?? [],
      };
      setState(done);
      if (!done.duplicate && done.prs.length === 0) router.push(`/activities/${done.activityId}`);
    } catch {
      setState({ kind: "error", message: "Réseau indisponible : réessaie quand tu es en ligne." });
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) void upload(file);
  }

  const busy = state.kind === "uploading";

  return (
    <div className="flex flex-col gap-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={
          dragging
            ? "rounded-2xl border-2 border-dashed border-accent bg-accent/10 p-6 text-center"
            : "rounded-2xl border-2 border-dashed border-border-strong bg-bg-elevated p-6 text-center"
        }
      >
        <p className="font-semibold">Dépose ton fichier .fit ici</p>
        <p className="mt-1 text-sm text-fg-muted">
          Export Garmin Connect, montre ou HRM-Pro : séance, laps, FC, allure, puissance, cadence,
          dynamique de course.
        </p>
        <label htmlFor="fit-file" className="sr-only">
          Fichier FIT
        </label>
        <input
          id="fit-file"
          ref={inputRef}
          type="file"
          accept=".fit,application/octet-stream"
          className="sr-only"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
            e.target.value = "";
          }}
        />
        <Button
          size="lg"
          className="mt-4"
          full
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? "Import en cours…" : "Choisir un fichier FIT"}
        </Button>
      </div>

      {state.kind === "uploading" ? (
        <p role="status" className="text-sm text-fg-muted">
          Analyse de <span className="font-mono">{state.name}</span>… (lecture du fichier, zones,
          métriques, liaison à la séance prévue)
        </p>
      ) : null}

      {state.kind === "error" ? (
        <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
          {state.message}
        </p>
      ) : null}

      {state.kind === "done" ? (
        <Card>
          <CardTitle>{state.duplicate ? "Déjà importée" : "Activité importée"}</CardTitle>
          <p className="mt-2 text-sm text-fg-muted">
            {state.duplicate
              ? "Ce fichier avait déjà été importé : rien n'a changé."
              : state.workoutId
                ? "La séance du jour est marquée terminée avec les données mesurées."
                : "Une séance terminée a été créée à partir des données mesurées."}
          </p>
          {state.prs.length ? (
            <ul className="mt-2 flex flex-col gap-1">
              {state.prs.map((p) => (
                <li key={p} className="text-sm font-semibold text-accent">
                  🎉 {p}
                </li>
              ))}
            </ul>
          ) : null}
          {state.warnings.length ? (
            <p className="mt-2 text-xs text-warn">
              Avertissements du lecteur FIT : {state.warnings.slice(0, 3).join(" · ")}
            </p>
          ) : null}
          <div className="mt-3 flex flex-col gap-2">
            <Link
              href={`/activities/${state.activityId}`}
              className="inline-flex h-12 items-center justify-center rounded-xl bg-accent px-4 font-semibold text-accent-fg"
            >
              Voir l&apos;activité
            </Link>
            {state.workoutId ? (
              <Link
                href={`/workouts/${state.workoutId}`}
                className="inline-flex h-12 items-center justify-center rounded-xl bg-bg-muted px-4 font-semibold"
              >
                Donner un RPE
              </Link>
            ) : null}
          </div>
        </Card>
      ) : null}

      <p className="text-xs text-fg-subtle">
        Les données brutes (résumé, laps, courbes à pleine résolution) sont conservées avec la
        version du lecteur : les métriques peuvent être recalculées plus tard sans réimporter.
      </p>
    </div>
  );
}
