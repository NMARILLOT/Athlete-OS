"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { createAndParseInboxAction } from "@/app/(app)/inbox/actions";

const QUICK = [
  "For time\n21-15-9\nThrusters 43/30\nPull-ups",
  "Back squat 5x5 lourd\n\n12 min AMRAP\n12 wall balls\n10 burpees\n250 m row",
  "EMOM 16\n1: 15 cal row\n2: 12 KB swings 24/16\n3: 10 box jumps\n4: rest",
];

/** Paste-first (spec §5): the raw text is saved before any parse; a visible "Analyse…" state follows. */
export function NewWodForm({
  defaultDate,
  defaultStart,
}: {
  defaultDate: string;
  defaultStart: string;
}) {
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  return (
    <form
      action={(fd) => start(async () => createAndParseInboxAction(fd))}
      className="flex flex-col gap-3"
    >
      <textarea
        name="text"
        required
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={9}
        placeholder={
          "Colle le WOD ici…\n\nex. Back squat 5x5\n12 min AMRAP\n12 wall balls\n10 burpees\n250 m row"
        }
        className="rounded-2xl border border-border bg-bg-elevated p-4 text-base outline-none focus:border-accent"
      />
      <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Exemples rapides">
        {QUICK.map((q, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setText(q)}
            className="h-9 shrink-0 rounded-full bg-bg-muted px-3 text-xs text-fg-muted"
          >
            Exemple {i + 1}
          </button>
        ))}
        <button
          type="button"
          onClick={async () =>
            setText((await navigator.clipboard.readText().catch(() => "")) || text)
          }
          className="h-9 shrink-0 rounded-full bg-bg-muted px-3 text-xs text-fg-muted"
        >
          Coller
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-fg-muted">Date</span>
          <input
            name="for"
            type="date"
            defaultValue={defaultDate}
            className="h-12 rounded-xl border border-border bg-bg-elevated px-3"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-fg-muted">Heure de la classe</span>
          <input
            name="start"
            type="time"
            defaultValue={defaultStart}
            className="h-12 rounded-xl border border-border bg-bg-elevated px-3"
          />
        </label>
      </div>
      <Button type="submit" size="lg" full disabled={pending || text.trim().length < 3}>
        {pending ? "Analyse…" : "Analyser le WOD"}
      </Button>
      <p className="text-xs text-fg-subtle">
        La photo/capture d&apos;écran arrive ensuite ; le texte reste la voie la plus fiable.
      </p>
    </form>
  );
}
