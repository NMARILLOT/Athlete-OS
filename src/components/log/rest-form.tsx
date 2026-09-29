"use client";

import { useState, useTransition } from "react";
import { logRestDayAction } from "@/app/(app)/log/actions";
import { Button } from "@/components/ui/button";
import { ErrorNote, TextInput, errorMessage } from "./fields";

/** "+ Jour de repos": one big button, an optional other date. */
export function RestForm({ today }: { today: string }) {
  const [date, setDate] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const [pending, run] = useTransition();

  function submit() {
    setError(null);
    run(async () => {
      try {
        await logRestDayAction(date);
      } catch (e) {
        setError(errorMessage(e));
      }
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-fg-muted">
        Le repos fait partie du plan. Le moteur en tient compte pour la suite de la semaine.
      </p>
      <Button size="xl" full disabled={pending} onClick={submit}>
        {pending
          ? "…"
          : date === today
            ? "Marquer aujourd'hui comme repos"
            : "Marquer ce jour comme repos"}
      </Button>
      <TextInput label="Autre date" type="date" value={date} onChange={setDate} />
      <ErrorNote message={error} />
    </div>
  );
}
