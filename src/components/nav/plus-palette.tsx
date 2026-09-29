"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Activity,
  Bike,
  ClipboardPlus,
  Dumbbell,
  FileUp,
  HeartPulse,
  Moon,
  Plus,
  Scale,
  Users,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";

/** Spec §87 "+" palette: every logging entry point, two taps away from anywhere. */
const ENTRIES = [
  {
    href: "/inbox/new",
    label: "Ajouter un WOD CrossFit",
    icon: ClipboardPlus,
    tone: "text-crossfit",
  },
  { href: "/train", label: "Démarrer une séance de force", icon: Dumbbell, tone: "text-strength" },
  {
    href: "/train/cardio/new",
    label: "Démarrer une séance cardio",
    icon: Bike,
    tone: "text-cardio-easy",
  },
  {
    href: "/log/activity",
    label: "Enregistrer une activité",
    icon: Activity,
    tone: "text-cardio-hard",
  },
  { href: "/log/coach", label: "Coaching CrossFit", icon: Users, tone: "text-coaching" },
  { href: "/log/rest", label: "Jour de repos", icon: Moon, tone: "text-recovery" },
  { href: "/log/pain", label: "Signaler une douleur", icon: HeartPulse, tone: "text-danger" },
  { href: "/log/body", label: "Mesure corporelle", icon: Scale, tone: "text-info" },
  { href: "/activities", label: "Mes activités", icon: Activity, tone: "text-cardio-easy" },
  {
    href: "/activities/import",
    label: "Importer un fichier FIT",
    icon: FileUp,
    tone: "text-fg-muted",
  },
] as const;

/** Routes where the floating button would sit on top of a primary CTA. */
const HIDDEN_PREFIXES = [
  "/train/strength/",
  "/onboarding",
  "/log/",
  "/inbox/new",
  "/activities/import",
];

export function PlusPalette() {
  const pathname = usePathname();
  // The sheet is bound to the route it was opened on: navigating closes it without an effect.
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const open = openedOn === pathname;
  const setOpen = (next: boolean) => setOpenedOn(next ? pathname : null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenedOn(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (HIDDEN_PREFIXES.some((p) => pathname.startsWith(p))) return null;

  return (
    <>
      <button
        type="button"
        aria-label={open ? "Fermer" : "Ajouter"}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          "fixed right-4 z-50 flex size-14 items-center justify-center rounded-full shadow-[var(--shadow-card)] transition-transform active:scale-95",
          "bottom-[calc(4.5rem+env(safe-area-inset-bottom))]",
          open ? "bg-bg-muted text-fg" : "bg-accent text-accent-fg",
        )}
      >
        {open ? <Plus className="size-7 rotate-45" /> : <Plus className="size-7" />}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Ajouter"
          className="fixed inset-0 z-40 flex items-end justify-center bg-black/60"
          onClick={() => setOpen(false)}
        >
          <div
            className="pb-safe w-full max-w-lg rounded-t-3xl bg-bg-elevated p-3 pb-24"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-2 py-1">
              <h2 className="text-xs font-semibold tracking-[0.14em] text-fg-muted uppercase">
                Ajouter
              </h2>
              <button
                type="button"
                aria-label="Fermer"
                onClick={() => setOpen(false)}
                className="flex size-9 items-center justify-center rounded-lg text-fg-muted"
              >
                <X className="size-5" />
              </button>
            </div>
            <ul className="mt-1 grid grid-cols-1 gap-1">
              {ENTRIES.map(({ href, label, icon: Icon, tone }) => (
                <li key={href}>
                  <Link
                    href={href}
                    className="flex min-h-12 items-center gap-3 rounded-xl px-3 py-2 text-[15px] font-medium hover:bg-bg-muted"
                  >
                    <Icon className={cn("size-5", tone)} aria-hidden />
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}
