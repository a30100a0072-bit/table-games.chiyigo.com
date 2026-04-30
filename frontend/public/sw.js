// Service Worker — minimal cache-first for static assets, network-first
// for everything else (API/WebSocket are cache-bypass by design).
//
// Workers are stateless — never cache /auth/token, /api/*, /rooms/*, or
// the JWKS endpoint. Stale auth would break sessions.

const CACHE = "chiyigo-tg-v2";
const STATIC = ["/", "/index.html", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(STATIC);
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Bypass everything dynamic — auth, game state, JWKS, settlement.
  if (url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/auth/") ||
      url.pathname.startsWith("/rooms/") ||
      url.pathname.startsWith("/.well-known/") ||
      url.protocol === "ws:" || url.protocol === "wss:") {
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    if (cached) return cached;
    try {
      const fresh = await fetch(req);
      // Cache successful same-origin responses.
      if (fresh.ok && url.origin === self.location.origin) {
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch {
      // Offline fallback — serve the index for navigation requests.
      if (req.mode === "navigate") {
        const root = await cache.match("/index.html");
        if (root) return root;
      }
      throw new Error("offline and not cached");
    }
  })());
});
