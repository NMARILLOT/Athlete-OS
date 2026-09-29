"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { planRestDayAction } from "@/app/(app)/calendar/actions";
import { isNextRedirect } from "@/lib/next-redirect";

/** "Repos" quick action on a future day card: one planned rest row per date (idempotent). */
export function RestQuickAction({ date }: { date: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      disabled={pending}
      aria-label={`Marquer le ${date} comme jour de repos`}
      title={failed ? "Impossible d'enregistrer pour le moment. Réessaie." : undefined}
      onClick={() =>
        start(async () => {
          setFailed(false);
          try {
            await planRestDayAction(date);
            router.refresh();
          } catch (err) {
            if (isNextRedirect(err)) throw err;
            setFailed(true);
          }
        })
      }
      className={
        failed
          ? "flex h-11 flex-1 items-center justify-center rounded-xl bg-danger/15 text-sm font-semibold text-danger disabled:opacity-50"
          : "flex h-11 flex-1 items-center justify-center rounded-xl bg-bg-muted text-sm font-semibold text-recovery disabled:opacity-50"
      }
    >
      {pending ? "…" : failed ? "Réessayer" : "Repos"}
    </button>
  );
}
