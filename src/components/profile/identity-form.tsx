"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateIdentityAction } from "@/app/(app)/profile/actions";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { errorMessage, FormError } from "@/components/profile/controls";
import { TIMEZONES } from "@/components/profile/labels";

export function IdentityForm({
  displayName,
  timezone,
  email,
}: {
  displayName: string;
  timezone: string;
  email: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(displayName);
  const [tz, setTz] = useState(timezone);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const dirty = name !== displayName || tz !== timezone;
  const zones: readonly string[] = TIMEZONES.includes(timezone as (typeof TIMEZONES)[number])
    ? TIMEZONES
    : [timezone, ...TIMEZONES];

  function save() {
    setError(null);
    setSaved(false);
    start(async () => {
      try {
        await updateIdentityAction({ displayName: name, timezone: tz });
        setSaved(true);
        router.refresh();
      } catch (e) {
        setError(errorMessage(e));
      }
    });
  }

  return (
    <Card>
      <CardTitle>Identité</CardTitle>
      <p className="mt-1 text-xs text-fg-subtle">{email}</p>
      <div className="mt-3 flex flex-col gap-3">
        <label htmlFor="display-name" className="flex flex-col gap-1">
          <span className="text-xs text-fg-muted">Prénom / pseudo</span>
          <input
            id="display-name"
            type="text"
            maxLength={80}
            autoComplete="nickname"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-12 rounded-xl border border-border bg-bg-muted/60 px-3 text-base"
          />
        </label>
        <label htmlFor="timezone" className="flex flex-col gap-1">
          <span className="text-xs text-fg-muted">Fuseau horaire</span>
          <select
            id="timezone"
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            className="h-12 rounded-xl border border-border bg-bg-muted/60 px-3 text-base"
          >
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-fg-subtle">
            Détermine « aujourd&apos;hui » pour le moteur et les journées locales.
          </span>
        </label>
        <FormError message={error} />
        <div className="flex items-center gap-3">
          <Button disabled={pending || !dirty} onClick={save}>
            {pending ? "…" : "Enregistrer"}
          </Button>
          {saved && !dirty ? <span className="text-sm text-accent">Enregistré</span> : null}
        </div>
      </div>
    </Card>
  );
}
