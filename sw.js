// sw.js — PathCurator PWA service worker (P4). Precache the app shell + SQLite-WASM for offline, then
// cache-first for same-origin GET (with runtime fill). It NEVER opens the DB, NEVER touches cross-origin
// (api.github.com stays uncached), and NEVER injects COOP/COEP (opfs-sahpool needs none). Classic
// script — no imports — so it works everywhere. The POST /add Web Share handler is added in the
// share-target step; until then POST is passed through.
//
// PRECACHE is enumerated EXPLICITLY: routes and dialogs are dynamically imported, so a glob would miss
// them and offline navigation to an unvisited route would 404. Keep this list in sync with the modules
// (the p4-pwa offline test navigates a route to catch drift).
const CACHE = 'pathcurator-v6';   // bump on precache/strategy changes → activate() purges the old one
const PRECACHE = [
  '/', '/index.html', '/manifest.webmanifest', '/src/ui/app.css',
  // ui modules
  '/src/ui/a11y.js', '/src/ui/attachments.js', '/src/ui/connect.js', '/src/ui/dom.js', '/src/ui/editors.js',
  '/src/ui/main.js', '/src/ui/markdown.js', '/src/ui/reorder.js', '/src/ui/router.js', '/src/ui/shell.js',
  '/src/ui/sync-indicator.js', '/src/ui/theme.js', '/src/ui/theme-guard.js', '/src/ui/frame-guard.js', '/src/ui/inbox-badge.js', '/src/ui/inbox-triage.js', '/src/ui/pathway-diff.js', '/src/ui/import-dialog.js', '/src/ui/download.js', '/src/ui/publish-html.js', '/src/ui/publish-feeds.js', '/src/ui/toast.js', '/src/ui/md-editor.js', '/src/ui/ext-bridge.js', '/src/ui/zip.js', '/src/ui/publish-scorm.js', '/src/ui/publish-moodle.js',
  // route/dialog modules (dynamically imported → precache explicitly)
  '/src/ui/views/dashboard.js', '/src/ui/views/merge.js', '/src/ui/views/notfound.js',
  '/src/ui/views/pathway.js', '/src/ui/views/sync.js', '/src/ui/views/inbox.js', '/src/ui/views/audit.js', '/src/ui/views/help.js', '/src/ui/help-content.js',
  // data modules
  '/src/data/canonical.js', '/src/data/capture-outbox.js', '/src/data/coordinator.js', '/src/data/db-worker.js', '/src/data/legacy.js', '/src/data/exchange.js', '/src/data/netscape.js',
  '/src/data/db.js', '/src/data/github.js', '/src/data/merge.js', '/src/data/schema.js', '/src/data/secrets.js',
  '/src/data/serialize.js', '/src/data/sync.js',
  // vendor (SQLite-WASM) — the worker instantiates these; precache so the DB boots offline
  '/vendor/index.mjs', '/vendor/sqlite3.wasm', '/vendor/sqlite3-opfs-async-proxy.js',
  // capture endpoint (DB-free) — reachable offline
  '/add/', '/add/add.js',
  // icons
  '/assets/icon-192.png', '/assets/icon-512.png', '/assets/icon-maskable.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                          // POST /add (share target) is a later step
  if (new URL(req.url).origin !== self.location.origin) return;   // never cache api.github.com etc.
  e.respondWith(networkFirst(req));
});

// NETWORK-FIRST (cache is the OFFLINE fallback only). Cache-first would freeze the app on whatever
// was precached at install and silently serve stale modules across code changes — an
// inconsistent module graph (e.g. a new view against an old db.js) that breaks a route while the
// shell still renders. Network-first means an online reload always gets fresh, mutually-consistent
// code; the precache + runtime-fill still make it work offline. (A hashed-precache build step is the
// eventual production optimization.)
async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());                 // refresh the offline copy
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    if (req.mode === 'navigate') {
      // Pathname-aware: an offline capture navigation is /add/?url=… — the query string misses the
      // bare precached /add/ entry, and falling back to index.html would silently EAT the capture
      // (the app shell never parses the params). Route /add navigations to the add page.
      const path = new URL(req.url).pathname;
      if (path === '/add' || path === '/add/') return (await cache.match('/add/')) || (await cache.match('/index.html'));
      return (await cache.match('/index.html')) || (await cache.match('/'));
    }
    throw err;
  }
}
