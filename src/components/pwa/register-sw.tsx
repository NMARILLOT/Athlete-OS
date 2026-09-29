"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import {
  rehydrateStrengthSession,
  requestPersistentStorage,
  useStrengthSession,
} from "@/stores/strength-session";

/**
 * Mounted once from the root layout:
 *  - asks for durable storage on first run (ARCHITECTURE §7: the offline session/outbox live in IndexedDB);
 *  - registers the service worker (production only);
 *  - flushes the strength outbox on app open, on every route change (so a batch kept after a 401
 *    goes out right after re-login, §4.6), on `online` and when the app comes back to the foreground
 *    (§4.4) — even when no strength shell is mounted, so an offline finish reaches the server as
 *    soon as the phone is back online, whatever screen the athlete is on. A queue owned by another
 *    account than the one the (app) layout publishes (`SessionOwner`) is never posted (§4.6).
 */
export function RegisterServiceWorker() {
  const pathname = usePathname();

  useEffect(() => {
    requestPersistentStorage();
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => {
        console.warn("[pwa] service worker registration failed", err);
      });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void rehydrateStrengthSession().then(() => {
      if (!cancelled) void useStrengthSession.getState().flushOutbox();
    });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === "hidden") return;
      void rehydrateStrengthSession().then(() => useStrengthSession.getState().flushOutbox());
    };
    window.addEventListener("online", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("online", flush);
      document.removeEventListener("visibilitychange", flush);
    };
  }, []);

  return null;
}
