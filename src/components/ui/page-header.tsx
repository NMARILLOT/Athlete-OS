"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, X } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Every non-tab route renders this: iOS standalone has no browser chrome (ARCHITECTURE §7).
 * The chevron goes back in history when there is somewhere to go back to; on a cold start / deep
 * link (one history entry) it falls back to `fallbackHref` instead of doing nothing.
 */
export function PageHeader({
  title,
  back = true,
  closeHref,
  fallbackHref = "/today",
  action,
}: {
  title: string;
  back?: boolean;
  closeHref?: string;
  /** Where the chevron goes when the history stack is empty (default: Today). */
  fallbackHref?: string;
  action?: ReactNode;
}) {
  const router = useRouter();
  return (
    <header className="pt-safe sticky top-0 z-30 -mx-4 mb-2 flex h-14 items-center gap-2 bg-bg/90 px-2 backdrop-blur">
      {closeHref ? (
        <Link
          href={closeHref}
          aria-label="Fermer"
          className="flex size-11 items-center justify-center rounded-xl text-fg-muted hover:text-fg"
        >
          <X className="size-6" />
        </Link>
      ) : back ? (
        <button
          type="button"
          aria-label="Retour"
          onClick={() => {
            if (window.history.length > 1) router.back();
            else router.replace(fallbackHref);
          }}
          className="flex size-11 items-center justify-center rounded-xl text-fg-muted hover:text-fg"
        >
          <ChevronLeft className="size-7" />
        </button>
      ) : (
        <span className="size-11" />
      )}
      <h1 className="flex-1 truncate text-lg font-semibold tracking-tight">{title}</h1>
      <div className="flex min-w-11 items-center justify-end">{action}</div>
    </header>
  );
}
