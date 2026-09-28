/* Athlete OS service worker — app-shell cache.
 * Strategy:
 *  - static assets (/_next/static, icons, fonts): cache-first
 *  - navigations: network-first with offline fallback to the last cached copy of the same URL, else /offline
 *  - API/server actions (POST) are never cached.
 * Authenticated HTML is cached per-URL only in this device's cache and never shared; the cache is cleared on logout
 * via the "LOGOUT" message.
 */
const VERSION = "v2";
const STATIC_CACHE = `athleteos-static-${VERSION}`;
const PAGE_CACHE = `athleteos-pages-${VERSION}`;
const OFFLINE_URL = "/offline";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(PAGE_CACHE).then((cache) => cache.add(OFFLINE_URL).catch(() => undefined)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith("athleteos-") && ![STATIC_CACHE, PAGE_CACHE].includes(k))
          .map((k) => caches.delete(k)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("message", (event) => {
  if (!event.data) return;
  if (event.data.type === "LOGOUT") {
    event.waitUntil(caches.delete(PAGE_CACHE));
  }
  // The strength shell asks to be precached so a cold start works offline (ARCHITECTURE §4):
  // the page HTML is fetched once more with credentials and stored per-URL in this device's cache.
  if (event.data.type === "PRECACHE" && Array.isArray(event.data.urls)) {
    event.waitUntil(
      caches.open(PAGE_CACHE).then((cache) =>
        Promise.all(
          event.data.urls.map((u) =>
            fetch(u, { credentials: "same-origin" })
              .then((res) => (res.ok ? cache.put(u, res) : undefined))
              .catch(() => undefined),
          ),
        ),
      ),
    );
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(PAGE_CACHE);
        try {
          const res = await fetch(req);
          if (res.ok) cache.put(req, res.clone());
          return res;
        } catch (_err) {
          const hit = await cache.match(req);
          if (hit) return hit;
          const offline = await cache.match(OFFLINE_URL);
          return offline || new Response("Hors ligne", { status: 503, headers: { "Content-Type": "text/plain" } });
        }
      })(),
    );
  }
});
