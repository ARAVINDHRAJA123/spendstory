/* SpendStory service worker.
   Strategy: cache the app shell (HTML/CSS/JS/icons) so the app opens
   instantly and works offline; NEVER cache /api responses — financial
   results must stay in memory only. */

// Bump this on every deploy that changes any SHELL file — stale-while-revalidate
// otherwise leaves returning visitors on a mismatched mix of old/new assets.
const CACHE = "spendstory-v5";
const SHELL = [
  ".",
  "index.html",
  "style.css",
  "app.js",
  "vendor/chart.umd.min.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.includes("/api/")) return; // network only

  // Stale-while-revalidate: serve cache fast, refresh in background.
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fresh = fetch(e.request)
        .then((res) => {
          if (res.ok && url.origin === location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
