// src/data/legacy-idb.js — same-origin rescue of PathCurator v1 data.
//
// v1 and v2 are DIFFERENT APPS THAT SHARE AN ORIGIN. At the pathcurator.com cutover, v2 replaces v1
// at the same URL — and v1 kept everything in an IndexedDB called PathCuratorDB, while v2 keeps its
// data in OPFS/SQLite. Nothing else in v2 ever looks at PathCuratorDB, so without this module a v1
// user opens the new app and sees an empty PathCurator: their pathways are still on their disk,
// simply unreachable through the UI. That is indistinguishable from "lost" for the person it
// happens to, and they have no way to fix it themselves once v1 is no longer served at that URL.
//
// STRICTLY READ-ONLY. This never writes to, upgrades, or deletes the v1 database — if an import
// goes wrong the original is still sitting there to try again. The one exception is a phantom
// database this module created itself while probing, which it cleans up (see dbExists).
//
// Shape note: v1's `pathways` store is one record PER pathway (keyPath 'id', plus a 'title' index),
// which is exactly the array convertLegacyPathways() in legacy.js already accepts — the same shape
// v1 serialised into curator-pathways.json. No second converter.

const DB_NAME = 'PathCuratorDB';
const STORE = 'pathways';

/**
 * Does the v1 database exist? Asking must not CREATE it: indexedDB.open() on an unknown name
 * silently brings an empty database into being, which would both litter the origin and make
 * "is there anything to rescue?" answer itself wrongly on the next call.
 */
async function dbExists() {
  if (typeof indexedDB === 'undefined') return false;
  if (typeof indexedDB.databases === 'function') {
    // The clean answer where it exists (Chrome/Edge/Safari, Firefox 126+).
    try { return (await indexedDB.databases()).some((d) => d.name === DB_NAME); }
    catch { /* some privacy modes throw — fall through to the probe */ }
  }
  // Fallback probe: open, and if WE turned out to be the one creating it, delete it again and
  // report absent. onupgradeneeded firing on a versionless open means it did not exist before.
  return new Promise((resolve) => {
    let created = false;
    let req;
    try { req = indexedDB.open(DB_NAME); } catch { return resolve(false); }
    req.onupgradeneeded = () => { created = true; };
    req.onerror = () => resolve(false);
    req.onblocked = () => resolve(false);
    req.onsuccess = () => {
      const db = req.result;
      const real = !created && db.objectStoreNames.contains(STORE);
      db.close();
      if (created) { try { indexedDB.deleteDatabase(DB_NAME); } catch { /* best effort */ } }
      resolve(real);
    };
  });
}

/**
 * The v1 pathways, straight out of IndexedDB. Never throws: a rescue offer that breaks the
 * dashboard would be worse than no rescue offer, so every failure reports "nothing found".
 * → { found, pathways }
 */
export async function readLegacyPathways() {
  const none = { found: false, pathways: [] };
  if (!(await dbExists())) return none;
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(DB_NAME); } catch { return resolve(none); }
    req.onerror = () => resolve(none);
    req.onblocked = () => resolve(none);
    req.onsuccess = () => {
      const db = req.result;
      const finish = (v) => { try { db.close(); } catch { /* already closed */ } resolve(v); };
      if (!db.objectStoreNames.contains(STORE)) return finish(none);
      try {
        const rq = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        rq.onsuccess = () => {
          const rows = Array.isArray(rq.result) ? rq.result.filter(Boolean) : [];
          finish({ found: rows.length > 0, pathways: rows });
        };
        rq.onerror = () => finish(none);
      } catch { finish(none); }
    };
  });
}

/** Cheap headline for the offer: how many pathways, and how many links across them. */
export function summarise(rows) {
  let links = 0;
  for (const p of rows || []) {
    for (const s of (Array.isArray(p?.steps) ? p.steps : [])) links += (Array.isArray(s?.bookmarks) ? s.bookmarks.length : 0);
  }
  return { pathways: (rows || []).length, links };
}
