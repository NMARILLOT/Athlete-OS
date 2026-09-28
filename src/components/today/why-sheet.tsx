"use client";

import { X } from "lucide-react";
import type { Recommendation } from "@/domain/engine";
import { DIMENSION_LABEL_FR, STIMULUS_LABEL_FR } from "@/domain/engine";
import type { LoadDimension, StimulusKey } from "@/domain/core";

/** "POURQUOI ?" — rendered from the trace, never from free text (spec §62, §100). */
export function WhySheet({
  recommendation: r,
  onClose,
}: {
  recommendation: Recommendation;
  onClose: () => void;
}) {
  const fired = r.rulesTriggered.filter(
    (h) => h.candidateKind === r.primary.kind || !h.candidateKind || h.effect === "veto",
  );
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="pb-safe max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-bg-elevated p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Pourquoi ?</h2>
          <button
            type="button"
            aria-label="Fermer"
            onClick={onClose}
            className="flex size-10 items-center justify-center rounded-xl text-fg-muted"
          >
            <X className="size-5" />
          </button>
        </div>
        <p className="mt-2 text-[15px]">{r.explanation}</p>

        <h3 className="mt-5 text-xs font-semibold tracking-[0.14em] text-fg-muted uppercase">
          Règles déclenchées
        </h3>
        <ul className="mt-2 flex flex-col gap-2">
          {fired.slice(0, 8).map((h, i) => (
            <li
              key={`${h.ruleId}-${h.candidateKind ?? ""}-${i}`}
              className="rounded-xl bg-bg-muted/60 px-3 py-2 text-sm"
            >
              <div className="flex items-center gap-2">
                <span
                  className={
                    h.effect === "veto"
                      ? "font-mono text-[11px] text-danger"
                      : h.effect === "note"
                        ? "font-mono text-[11px] text-info"
                        : "font-mono text-[11px] text-accent"
                  }
                >
                  {h.ruleId}
                </span>
                {h.candidateKind && h.candidateKind !== r.primary.kind ? (
                  <span className="text-[11px] text-fg-subtle">({h.candidateKind})</span>
                ) : null}
              </div>
              <p className="mt-0.5 text-fg-muted">{h.message}</p>
            </li>
          ))}
          {fired.length === 0 ? (
            <li className="text-sm text-fg-muted">
              Aucune contrainte particulière : la séance comble simplement ce qui manque.
            </li>
          ) : null}
        </ul>

        <h3 className="mt-5 text-xs font-semibold tracking-[0.14em] text-fg-muted uppercase">
          Fatigue résiduelle
        </h3>
        <ul className="mt-2 grid grid-cols-3 gap-2 text-sm">
          {(Object.entries(r.trace.derived.fatigueRatio) as Array<[LoadDimension, number]>).map(
            ([dim, ratio]) => (
              <li key={dim} className="rounded-xl bg-bg-muted/60 px-3 py-2">
                <div className="text-[11px] text-fg-subtle">{DIMENSION_LABEL_FR[dim]}</div>
                <div
                  className={
                    ratio >= 1
                      ? "font-semibold text-danger"
                      : ratio >= 0.6
                        ? "font-semibold text-warn"
                        : "font-semibold"
                  }
                >
                  {Math.round(ratio * 100)} %
                </div>
              </li>
            ),
          )}
        </ul>

        <h3 className="mt-5 text-xs font-semibold tracking-[0.14em] text-fg-muted uppercase">
          Ce qui manque cette semaine
        </h3>
        <ul className="mt-2 flex flex-wrap gap-2">
          {r.trace.derived.topGaps.map((g) => (
            <li key={g.key} className="rounded-full bg-bg-muted/60 px-3 py-1 text-sm">
              {STIMULUS_LABEL_FR[g.key as StimulusKey]}{" "}
              <span className="text-fg-muted">{g.projectedGap.toFixed(1)}</span>
            </li>
          ))}
        </ul>

        <p className="mt-5 text-[11px] text-fg-subtle">
          Confiance {r.confidence.level.toLowerCase()} ({Math.round(r.confidence.score * 100)} %) ·{" "}
          {r.engineVersion} · budget dur restant {r.trace.derived.hardBudgetRemaining} ·{" "}
          {r.trace.derived.hardDone6d} séance(s) dure(s) sur 6 j
        </p>
      </div>
    </div>
  );
}
