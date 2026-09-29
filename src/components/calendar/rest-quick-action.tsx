"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { planRestDayAction } from "@/app/(app)/calendar/actions";

/** "Repos" quick action on a future day card: one planned rest row per date (idempotent). */
export function RestQuickAction({ date }: { date: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      aria-label={`Marquer le ${date} comme jour de repos`}
      onClick={() =>
        start(async () => {
          await planRestDayAction(date);
          router.refresh();
        })
      }
      className="flex h-11 flex-1 items-center justify-center rounded-xl bg-bg-muted text-sm font-semibold text-recovery disabled:opacity-50"
    >
      {pending ? "…" : "Repos"}
    </button>
  );
}
