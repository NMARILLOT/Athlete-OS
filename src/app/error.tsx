"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/** Error boundary for the routes outside the app shell (login, offline, root redirect). */
export default function RootError({
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
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Un problème est survenu</h1>
        <p className="mt-2 text-fg-muted">
          La page n&apos;a pas pu se charger. Vérifie ta connexion et réessaie.
        </p>
      </div>
      <Button size="lg" full onClick={() => (retry ?? reset)()}>
        Réessayer
      </Button>
      <Link
        href="/today"
        className="text-center text-sm text-fg-muted underline-offset-4 hover:underline"
      >
        Aller à Aujourd&apos;hui
      </Link>
      {error.digest ? (
        <p className="text-center font-mono text-[11px] text-fg-subtle">Réf. {error.digest}</p>
      ) : null}
    </main>
  );
}
