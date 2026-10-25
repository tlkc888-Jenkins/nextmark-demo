// NextMark service worker.
//
// The app has to work with no signal at all — past the breakers there is none,
// and the course pack plus the world coastline are exactly what you cannot
// fetch on the way to the first mark. So everything is precached on install and
// served cache-first, with a background refresh when there is signal.

const CACHE = 'nextmark-v5';

const SHELL = [
  './',
  'race.html',
  'index.html',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'app/app.css',
  'app/app.js',
  'app/geo.js',
  'app/store.js',
  'app/race.js',
  'app/chart.js',
  'app/coast.js',
  'app/ingest.js',
  'app/share.js',
  'data/syc-offshore-2627.json',
  'data/coast-syc.json',
  'data/coast-world.json',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // Add individually so one failure cannot abort the whole install and leave
    // the app with no offline copy at all.
    await Promise.all(SHELL.map(async url => {
      try { await c.add(new Request(url, { cache: 'reload' })); }
      catch (err) { console.warn('[nextmark] could not precache', url, err); }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/** How long to wait for the network before falling back to cache, for code. */
const NET_TIMEOUT_MS = 2500;

/**
 * Two strategies, because "works offshore" and "a fix reaches the crew" pull in
 * opposite directions.
 *
 *   App code (HTML, JS, CSS) — network-first with a short timeout. Eight phones
 *   that installed this last week must pick up a fix the next time they open it
 *   on signal, not a version later. Offshore the timeout expires in 2.5 s and
 *   the cached copy is served, so nothing is lost.
 *
 *   Bulk data (the course pack, the coastlines, icons) — cache-first. It is
 *   large, it almost never changes, and it is exactly what cannot be fetched on
 *   the way to the first mark.
 */
function isAppCode(url) {
  return /\.(?:html|js|css)$/.test(url.pathname) || url.pathname.endsWith('/');
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never cache the API call that reads the briefing board, and never touch
  // cross-origin requests at all.
  if (url.origin !== self.location.origin) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = () => cache.match(req, { ignoreSearch: true });

    const fromNet = fetch(req).then(res => {
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);

    if (isAppCode(url) || req.mode === 'navigate') {
      const raced = await Promise.race([
        fromNet,
        new Promise(r => setTimeout(() => r(null), NET_TIMEOUT_MS)),
      ]);
      if (raced) return raced;
      const hit = await cached();
      if (hit) return hit;
      const late = await fromNet;
      if (late) return late;
      if (req.mode === 'navigate') {
        const shell = await cache.match('race.html');
        if (shell) return shell;
      }
    } else {
      const hit = await cached();
      if (hit) return hit;
      const net = await fromNet;
      if (net) return net;
    }

    return new Response('Offline and not cached.', {
      status: 503, headers: { 'content-type': 'text/plain' },
    });
  })());
});
