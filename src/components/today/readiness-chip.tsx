"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { declareReadinessAction } from "@/app/(app)/today/actions";
import type { ReadinessDeclaredView } from "@/server/services/view-models";

const ENERGY = [
  { v: 1, label: "😫" },
  { v: 2, label: "😐" },
  { v: 3, label: "😃" },
];
const SORENESS = [0, 1, 2, 3];

/** Three taps max (spec §21): energy, soreness, motivation; optional unusual pain. */
export function ReadinessChip({
  date,
  declared,
}: {
  date: string;
  declared: ReadinessDeclaredView | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [energy, setEnergy] = useState<number | null>(declared?.energy ?? null);
  const [soreness, setSoreness] = useState<number | null>(declared?.soreness ?? null);
  const [motivation, setMotivation] = useState<number | null>(declared?.motivation ?? null);
  const [pain, setPain] = useState<boolean>(declared?.unusualPain ?? false);
  const [pending, start] = useTransition();

  function save() {
    if (energy == null || soreness == null || motivation == null) return;
    start(async () => {
      await declareReadinessAction({
        date,
        energy: energy as 1 | 2 | 3,
        soreness: soreness as 0 | 1 | 2 | 3,
        motivation: motivation as 1 | 2 | 3,
        unusualPain: pain,
      });
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          declared
            ? "h-9 rounded-full bg-accent/15 px-3 text-sm font-semibold text-accent"
            : "h-9 rounded-full bg-bg-muted px-3 text-sm font-semibold text-fg-muted"
        }
      >
        {declared
          ? `Forme ${ENERGY.find((e) => e.v === declared.energy)?.label ?? ""}`
          : "Comment tu te sens ?"}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60"
          onClick={() => setOpen(false)}
        >
          <div
            className="pb-safe w-full max-w-lg rounded-t-3xl bg-bg-elevated p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold">Ce matin</h2>
            <Row label="Énergie">
              {ENERGY.map((e) => (
                <Tap key={e.v} active={energy === e.v} onClick={() => setEnergy(e.v)}>
                  {e.label}
                </Tap>
              ))}
            </Row>
            <Row label="Courbatures">
              {SORENESS.map((s) => (
                <Tap key={s} active={soreness === s} onClick={() => setSoreness(s)}>
                  {s}
                </Tap>
              ))}
            </Row>
            <Row label="Envie de s'entraîner">
              {ENERGY.map((e) => (
                <Tap key={e.v} active={motivation === e.v} onClick={() => setMotivation(e.v)}>
                  {e.label}
                </Tap>
              ))}
            </Row>
            <Row label="Douleur inhabituelle ?">
              <Tap active={!pain} onClick={() => setPain(false)}>
                Non
              </Tap>
              <Tap active={pain} onClick={() => setPain(true)}>
                Oui
              </Tap>
            </Row>
            {pain ? (
              <p className="mt-2 text-sm text-fg-muted">
                Tu pourras préciser la localisation via + → Douleur.
              </p>
            ) : null}
            <button
              type="button"
              onClick={save}
              disabled={pending || energy == null || soreness == null || motivation == null}
              className="mt-5 h-14 w-full rounded-2xl bg-accent text-lg font-semibold text-accent-fg disabled:opacity-50"
            >
              {pending ? "…" : "Valider"}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <p className="text-sm text-fg-muted">{label}</p>
      <div className="mt-2 flex gap-2">{children}</div>
    </div>
  );
}

function Tap({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? "h-14 flex-1 rounded-2xl bg-accent text-xl font-semibold text-accent-fg"
          : "h-14 flex-1 rounded-2xl bg-bg-muted text-xl"
      }
    >
      {children}
    </button>
  );
}
