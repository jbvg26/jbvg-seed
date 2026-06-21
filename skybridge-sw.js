/**
 * skybridge-sw.js
 * SkyBridge Service Worker
 *
 * Caches the SkyBridge shell so JBVG works when Core is unreachable.
 * Serves cached assets offline. Queues writes to Ghost for replay.
 *
 * Install at: /seed/skybridge-sw.js
 * Register from: index.html
 */

const SW_VERSION    = "skybridge-v1.0";
const SHELL_CACHE   = `${SW_VERSION}-shell`;
const DATA_CACHE    = `${SW_VERSION}-data`;

// Assets to cache on install -- the SkyBridge shell
const SHELL_ASSETS = [
  "/skybridge.js",
  "/route-manifest.json",
  "/index.html",
  "/skybridge-db.js",
];

// ── Install ───────────────────────────────────────────────────
self.addEventListener("install", (event) => {
  console.log("[SkyBridge:SW] Installing...");
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => {
      return cache.addAll(SHELL_ASSETS);
    }).then(() => {
      console.log("[SkyBridge:SW] Shell cached");
      return self.skipWaiting();
    })
  );
});

// ── Activate ──────────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  console.log("[SkyBridge:SW] Activating...");
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter(k => k !== SHELL_CACHE && k !== DATA_CACHE)
            .map(k => caches.delete(k))
      );
    }).then(() => {
      console.log("[SkyBridge:SW] Old caches cleared");
      return self.clients.claim();
    })
  );
});

// ── Fetch ─────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Shell assets -- cache first
  if (SHELL_ASSETS.some(a => url.pathname.endsWith(a.split("/").pop()))) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          const clone = response.clone();
          caches.open(SHELL_CACHE).then(cache => cache.put(event.request, clone));
          return response;
        });
      })
    );
    return;
  }

  // SkyBridge manifest -- cache with network fallback
  if (url.pathname.includes("route-manifest")) {
    event.respondWith(
      fetch(event.request).then(response => {
        const clone = response.clone();
        caches.open(DATA_CACHE).then(cache => cache.put(event.request, clone));
        return response;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // Core API calls -- network first, Ghost fallback
  if (url.hostname.includes("core.jbventuresinc") ||
      url.hostname.includes("jbventuresgroupinc")) {
    event.respondWith(
      fetch(event.request).catch(() => {
        // Core unreachable -- return offline response
        return new Response(JSON.stringify({
          ok: false,
          offline: true,
          message: "Core unreachable. SkyBridge operating in continuity mode.",
          ts: Date.now()
        }), {
          status: 503,
          headers: { "Content-Type": "application/json",
                     "X-SkyBridge-Mode": "continuity" }
        });
      })
    );
    return;
  }

  // Everything else -- network only
  event.respondWith(fetch(event.request));
});

// ── Background sync ───────────────────────────────────────────
self.addEventListener("sync", (event) => {
  if (event.tag === "skybridge-ghost-flush") {
    event.waitUntil(flushGhostQueue());
  }
});

async function flushGhostQueue() {
  // Signal all clients to flush their Ghost queues
  const clients = await self.clients.matchAll();
  clients.forEach(client => {
    client.postMessage({ type: "skybridge-flush-queue" });
  });
}

// ── Message handler ───────────────────────────────────────────
self.addEventListener("message", (event) => {
  if (event.data?.type === "skybridge-sw-version") {
    event.source.postMessage({ type: "skybridge-sw-version", version: SW_VERSION });
  }
  if (event.data?.type === "skybridge-sw-update") {
    self.skipWaiting();
  }
});

console.log(`[SkyBridge:SW] ${SW_VERSION} loaded`);
