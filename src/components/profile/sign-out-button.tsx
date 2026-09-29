"use client";

import { useState } from "react";
import { signOutAction } from "@/app/(app)/profile/actions";
import { clearClientCaches } from "@/components/pwa/client-cache";
import { Button } from "@/components/ui/button";
import { errorMessage, FormError } from "@/components/profile/controls";
import { rehydrateStrengthSession, useStrengthSession } from "@/stores/strength-session";

/**
 * Sign-out as a client flow (ARCHITECTURE §4.6, §7): flush the strength outbox first and refuse
 * while it is still non-empty (an offline finish must not be abandoned), then clear the per-device
 * caches (service-worker page cache, IndexedDB session) and only then call the server action.
 */
export function SignOutButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingEvents, setPendingEvents] = useState<number>(0);

  async function signOut() {
    setPending(true);
    setError(null);
    setPendingEvents(0);
    try {
      await rehydrateStrengthSession();
      const store = useStrengthSession.getState();
      if (store.outbox.length > 0) {
        await store.flushOutbox();
        const left = useStrengthSession.getState().outbox.length;
        if (left > 0) {
          setPendingEvents(left);
          return;
        }
      }
      await clearClientCaches();
      await signOutAction();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-2">
      <Button variant="outline" full size="lg" disabled={pending} onClick={signOut}>
        {pending ? "Déconnexion…" : "Se déconnecter"}
      </Button>
      {pendingEvents > 0 ? (
        <p role="status" className="text-sm text-warn">
          {pendingEvents} événement(s) de séance non synchronisé(s) — réessaie en ligne avant de te
          déconnecter, sinon ils seraient perdus.
        </p>
      ) : null}
      <FormError message={error} />
    </div>
  );
}
