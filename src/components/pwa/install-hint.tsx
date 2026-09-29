"use client";

import { Share, X } from "lucide-react";
import { useSyncExternalStore } from "react";

const DISMISS_KEY = "athleteos:install-hint:dismissed";

/** Tiny external store: the hint's visibility is derived from the browser, not from React state. */
const listeners = new Set<() => void>();
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function notify(): void {
  for (const cb of listeners) cb();
}

function shouldShow(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  const standalone =
    nav.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
  if (standalone) return false;
  const ua = navigator.userAgent;
  const isIos = /iPhone|iPad|iPod/i.test(ua) && !/CriOS|FxiOS/i.test(ua);
  if (!isIos) return false;
  try {
    return window.localStorage.getItem(DISMISS_KEY) !== "1";
  } catch {
    return true; // private mode: show it, it stays dismissable for the session
  }
}

let sessionDismissed = false;
function getSnapshot(): boolean {
  return !sessionDismissed && shouldShow();
}
function getServerSnapshot(): boolean {
  return false;
}

/**
 * iOS Safari never fires `beforeinstallprompt`: the only way to get the standalone app is
 * Partager → « Sur l'écran d'accueil ». Shown once (dismissable) when the app is opened in the
 * iPhone browser rather than from the home screen; hidden in standalone mode and elsewhere.
 * localStorage is a per-device convenience only (spec §85 install hints).
 */
export function InstallHint() {
  const visible = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  if (!visible) return null;

  function dismiss() {
    sessionDismissed = true;
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
    notify();
  }

  return (
    <div
      role="note"
      className="fixed inset-x-4 z-40 flex items-start gap-3 rounded-2xl border border-border bg-bg-elevated p-3 text-sm shadow-[var(--shadow-card)]"
      style={{ bottom: "calc(8.5rem + env(safe-area-inset-bottom))" }}
    >
      <Share className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
      <p className="flex-1 leading-snug text-fg">
        Installe Athlete OS : touche <span className="font-semibold">Partager</span> puis{" "}
        <span className="font-semibold">« Sur l&apos;écran d&apos;accueil »</span>. L&apos;app
        s&apos;ouvre alors en plein écran et la séance de force fonctionne hors ligne.
      </p>
      <button
        type="button"
        aria-label="Fermer"
        onClick={dismiss}
        className="flex size-9 shrink-0 items-center justify-center rounded-lg text-fg-muted"
      >
        <X className="size-5" />
      </button>
    </div>
  );
}
