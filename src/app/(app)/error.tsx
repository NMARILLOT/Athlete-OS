"use client";

import Link from "next/link";
import { useEffect } from "react";
import { SignOutButton } from "@/components/profile/sign-out-button";
import { Button } from "@/components/ui/button";

/**
 * Route-level error boundary for the app shell (Today, Inbox, Calendar…): a failed render or a
 * server action that throws inside a transition lands here instead of Next's bare crash page.
 * The bottom nav stays mounted (the layout above is not wrapped), so a failure is never a dead end.
 * Sign-out is offered as the last resort: it does not need a valid session (an account outside
 * ALLOWED_EMAILS or a broken environment cannot reach the Profile page to find it).
 */
export default function AppError({
  error,
  retry,
  reset,
}: {
  error: Error & { digest?: string };
  retry?: () => void;
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <section className="flex flex-col gap-4 py-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Un problème est survenu</h1>
        <p className="mt-2 text-fg-muted">
          L&apos;écran n&apos;a pas pu se charger. Vérifie ta connexion et réessaie ; si ça
          persiste, reviens à Aujourd&apos;hui.
        </p>
      </div>
      <Button size="lg" onClick={() => (retry ?? reset)()}>
        Réessayer
      </Button>
      <Link
        href="/today"
        className="text-center text-sm text-fg-muted underline-offset-4 hover:underline"
      >
        Retour à Aujourd&apos;hui
      </Link>
      <div className="mt-6 border-t border-border pt-4">
        <p className="text-sm text-fg-muted">
          Toujours bloqué ? Déconnecte-toi puis reconnecte-toi.
        </p>
        <SignOutButton />
      </div>
      {error.digest ? (
        <p className="text-center font-mono text-[11px] text-fg-subtle">Réf. {error.digest}</p>
      ) : null}
    </section>
  );
}
