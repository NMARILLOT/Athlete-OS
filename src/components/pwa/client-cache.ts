"use client";

import { clearStrengthSessionStorage } from "@/stores/strength-session";

const PAGE_CACHE_PREFIX = "athleteos-pages-";

/**
 * Per-device hygiene when the athlete signs out or deletes the account (ARCHITECTURE §4.6, §7):
 *  - the service worker drops its page cache (authenticated HTML of /today, /workouts/…), both via
 *    the `LOGOUT` message and directly from the window (works even before the SW controls the page);
 *  - the persisted strength session / outbox in IndexedDB is removed so nothing of this account
 *    leaks into the next one on the same phone.
 * Every step is best-effort: a missing API must never block the sign-out itself.
 */
export async function clearClientCaches(): Promise<void> {
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: "LOGOUT" });
  } catch {
    /* no service worker */
  }
  try {
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith(PAGE_CACHE_PREFIX)).map((k) => caches.delete(k)),
      );
    }
  } catch {
    /* Cache API unavailable */
  }
  await clearStrengthSessionStorage();
}
