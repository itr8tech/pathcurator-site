// src/data/capture-outbox.js — the durable capture queue (P4). Runs in ANY context — a normal tab,
// a read-only follower, or the service worker — so it imports NOTHING and touches no DOM. Every
// capture transport (bookmarklet / manual / Web Share) appends a CapturePayload here; the PRIMARY
// tab is the sole consumer and drains it into the SQLite `inbox` table (db.js drainCaptureOutbox).
//
// This exists because `opfs-sahpool` allows exactly one DB connection (the primary's) — a follower
// or the service worker cannot write `inbox` directly, but IndexedDB is same-origin and multi-writer.
// Unencrypted (captures aren't secret) — otherwise it copies the memoized-Promise IndexedDB pattern
// from secrets.js. The store uses an IN-LINE key `ref`, so a re-append with the same ref OVERWRITES
// rather than duplicating (belt-and-suspenders with the SQLite ux_inbox_ref unique index at drain).

const DB_NAME = 'PathCuratorCapture';
const STORE = 'outbox';
const SIGNAL = 'pathcurator-capture';   // BroadcastChannel name: {type:'capture'} nudges the primary

let dbPromise = null;
function idb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'ref' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function tx(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const rq = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(rq ? rq.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// ONE reusable poster channel (created lazily; absent → BroadcastChannel unsupported, primary still
// drains on foreground/promote). Never receives its own posts, so it can't self-trigger.
let postChannel;
function poster() {
  if (postChannel !== undefined) return postChannel;
  try { postChannel = new BroadcastChannel(SIGNAL); } catch { postChannel = null; }
  return postChannel;
}

/** Wake a running primary so it drains immediately (else it drains on next foreground/promote). */
export function signalPrimary() {
  try { poster()?.postMessage({ type: 'capture' }); } catch { /* channel gone → foreground drain */ }
}

/** Subscribe to capture signals (the primary uses this to drain on demand). Returns unsubscribe. */
export function onSignal(cb) {
  let ch = null;
  try { ch = new BroadcastChannel(SIGNAL); ch.onmessage = (e) => { if (e.data?.type === 'capture') cb(); }; }
  catch { /* no BroadcastChannel */ }
  return () => { try { ch?.close(); } catch { /* already closed */ } };
}

/**
 * Append (or overwrite by `ref`) a CapturePayload, then nudge the primary. A missing `ref` is minted
 * so nothing is silently mis-keyed (the store needs an in-line key) and re-submits stay idempotent.
 * Returns the effective ref.
 */
export async function append(payload) {
  const rec = { ...payload, ref: payload?.ref || `capture:${crypto.randomUUID()}` };
  await tx('readwrite', (s) => s.put(rec));
  signalPrimary();
  return rec.ref;
}

/** Every queued payload (the primary reads, materializes each into `inbox`, then remove()s it). */
export function drainAll() { return tx('readonly', (s) => s.getAll()); }

/** Delete one payload by ref — called ONLY after its inbox row is committed (crash-safe drain). */
export function remove(ref) { return tx('readwrite', (s) => s.delete(ref)); }

/** How many payloads are queued (drives the “N waiting” signal / tests). */
export function count() { return tx('readonly', (s) => s.count()); }
