"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { resolvePainAction } from "@/app/(app)/profile/actions";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { errorMessage, FormError } from "@/components/profile/controls";
import { PAIN_LOCATION_LABEL_FR, SIDE_LABEL_FR } from "@/components/profile/labels";
import type { ProfilePainView } from "@/server/services/profile.service";
import { formatDateShort } from "@/lib/format";

export function PainList({ pains }: { pains: ProfilePainView[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();

  function resolve(id: string) {
    setError(null);
    setBusy(id);
    start(async () => {
      try {
        await resolvePainAction(id);
        router.refresh();
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(null);
      }
    });
  }

  return (
    <Card>
      <div className="flex items-center justify-between">
        <CardTitle>Douleurs actives</CardTitle>
        <Link
          href="/log/pain"
          className="flex min-h-11 items-center text-sm font-semibold text-accent"
        >
          + Signaler
        </Link>
      </div>
      {pains.length === 0 ? (
        <p className="mt-2 text-sm text-fg-muted">Aucune douleur déclarée.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {pains.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between gap-3 rounded-xl bg-bg-muted/60 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="font-medium">
                  {PAIN_LOCATION_LABEL_FR[p.location]}
                  {p.side ? ` ${SIDE_LABEL_FR[p.side] ?? p.side}` : ""}
                  <span className="ml-2 text-sm text-fg-muted tabular-nums">{p.intensity}/10</span>
                </p>
                <p className="text-xs text-fg-subtle">
                  depuis le {formatDateShort(p.reportedAt.slice(0, 10))}
                  {p.status === "improving" ? " · en amélioration" : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Chip tone={p.status === "improving" ? "info" : "danger"}>
                  {p.status === "improving" ? "Mieux" : "Active"}
                </Chip>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy === p.id}
                  onClick={() => resolve(p.id)}
                >
                  {busy === p.id ? "…" : "Résolue"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <FormError message={error} />
    </Card>
  );
}
