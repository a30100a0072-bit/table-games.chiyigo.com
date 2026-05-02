// Service Worker — multi-strategy cache.
//
// 1. App shell + Vite asset chunks → stale-while-revalidate. The user
//    sees the cached copy instantly; we kick off a background fetch
//    and update the cache for the NEXT load. Solves both "feels slow"
//    on slow networks AND "stale forever after a bad cache".
// 2. Settled replays (GET /api/replays/:gameId and the public
//    by-token variant) → cache-first with TTL. Replay payloads are
//    immutable once a game settles, so caching them lets the replay
//    player work fully offline once you've opened a replay at least
//    once. Cache key is the URL — entries are per-browser, so no
//    cross-user leak.
// 3. Everything else dynamic (auth, wallet, match, JWKS, WS) →
//    network-only / bypass.
//
// Bump CACHE on shape changes so old SW data evicts cleanly.

const CACHE         = "chiyigo-tg-v3";
const REPLAY_CACHE  = "chiyigo-replays-v1";
const REPLAY_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
const STATIC = ["/", "/index.html", "/manifest.json", "/sw-register.js"];

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
    // Drop any cache that isn't on the keep-list. Replay cache survives
    // SW upgrades — its entries carry their own TTL via x-cached-at and
    // dropping them would lose offline replays for no good reason.
    const keep = new Set([CACHE, REPLAY_CACHE]);
    await Promise.all(keys.filter(k => !keep.has(k)).map(k => caches.delete(k)));
    self.clients.claim();
  })());
});

// ── strategy: stale-while-revalidate ────────────────────────────────
// Serve cached if present; in parallel, fetch fresh and update cache
// for the NEXT request. Falls back to network-only if there's no
// cached entry (e.g. cold start), then caches the response.
async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);

  const networkPromise = fetch(req).then(resp => {
    if (resp.ok && new URL(req.url).origin === self.location.origin) {
      cache.put(req, resp.clone()).catch(() => {});
    }
    return resp;
  }).catch(() => null);

  return cached || (await networkPromise) || Response.error();
}

// ── strategy: cache-first with TTL (replays) ───────────────────────
// Stamp x-cached-at on the stored response. On hit, evict if older
// than TTL; otherwise serve cache. Misses fall through to network.
async function cacheFirstWithTTL(req, cacheName, ttlMs) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) {
    const stamp = Number(cached.headers.get("x-cached-at") ?? 0);
    if (Date.now() - stamp < ttlMs) return cached;
    // Stale — let the network attempt run, fall back to stale on failure.
  }
  try {
    const fresh = await fetch(req);
    if (fresh.ok) {
      // Re-clone with our timestamp so we know when to evict.
      const headers = new Headers(fresh.headers);
      headers.set("x-cached-at", String(Date.now()));
      const stamped = new Response(await fresh.clone().blob(), {
        status: fresh.status, statusText: fresh.statusText, headers,
      });
      cache.put(req, stamped).catch(() => {});
    }
    return fresh;
  } catch {
    if (cached) return cached;          // serve stale rather than fail
    return Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Same-origin app shell + Vite asset chunks → SWR.
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req, CACHE));
    return;
  }

  // Replay GET — both authed-by-gameId and public-by-token. Settled
  // replays are immutable so cache-first with TTL is safe and lets
  // the replay player work offline.
  const isReplayGet = (
    /\/api\/replays\/[^/]+$/.test(url.pathname) ||
    /\/api\/replays\/by-token\/[^/]+$/.test(url.pathname)
  );
  if (isReplayGet) {
    event.respondWith(cacheFirstWithTTL(req, REPLAY_CACHE, REPLAY_TTL_MS));
    return;
  }

  // Bypass everything else dynamic — auth, game state, JWKS, settlement.
  // (Letting respondWith fall through with no handler does the right
  // thing: the browser handles the request normally.)
});
