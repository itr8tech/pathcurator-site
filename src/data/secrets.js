// PathCurator v2 — secrets (P1). Main-thread owner of sensitive material.
// Per-workspace GitHub PATs + Basic-auth creds live in a SEPARATE IndexedDB DB, encrypted
// under a NON-EXTRACTABLE AES-GCM key. They NEVER touch the SQLite/OPFS DB, exports, or commits.
//
// Honest threat model: a static app cannot hide a secret from same-origin code (XSS can call
// decrypt or read a token in flight). Encryption here buys: no plaintext at rest, secrets
// excluded from the DB/exports/commits, and — with a non-extractable key — the raw key bytes
// can't be exfiltrated to another origin. The wrapping key is obtained via a SWAPPABLE provider
// so a WebAuthn-PRF (device-bound) key can drop in later with zero change to storage (O6).

const DB_NAME = 'PathCuratorSecrets';
const KEYS_STORE = 'keys';
const VALS_STORE = 'vals';
const KEY_ID = 'wrap-aes-gcm-v1';

let dbPromise = null;
function idb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KEYS_STORE)) db.createObjectStore(KEYS_STORE);
      if (!db.objectStoreNames.contains(VALS_STORE)) db.createObjectStore(VALS_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function op(store, mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const rq = fn(t.objectStore(store));
    t.oncomplete = () => resolve(rq ? rq.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const idbGet = (store, key) => op(store, 'readonly', (s) => s.get(key));
const idbPut = (store, key, val) => op(store, 'readwrite', (s) => s.put(val, key));
const idbDel = (store, key) => op(store, 'readwrite', (s) => s.delete(key));

// --- swappable wrapping-key provider (default: non-extractable AES key kept in IndexedDB) ---
let keyProvider = {
  async getWrappingKey() {
    const existing = await idbGet(KEYS_STORE, KEY_ID);
    if (existing) return existing;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, /* extractable */ false, ['encrypt', 'decrypt']);
    await idbPut(KEYS_STORE, KEY_ID, key); // structured-clone; raw key bytes never enter JS
    return key;
  },
};
/** Replace the wrapping-key source (e.g. a future WebAuthn-PRF provider). O6 seam. */
export function setKeyProvider(provider) { keyProvider = provider; }

async function encrypt(plaintext) {
  const key = await keyProvider.getWrappingKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return { iv, ct };
}
async function decrypt(rec) {
  const key = await keyProvider.getWrappingKey();
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, key, rec.ct);
  return new TextDecoder().decode(pt);
}

export async function setSecret(id, value) {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  await idbPut(VALS_STORE, id, await encrypt(str));
}
export async function getSecret(id, asJson = false) {
  const rec = await idbGet(VALS_STORE, id);
  if (!rec) return null;
  const str = await decrypt(rec);
  return asJson ? JSON.parse(str) : str;
}
export async function deleteSecret(id) { await idbDel(VALS_STORE, id); }
export async function hasSecret(id) { return (await idbGet(VALS_STORE, id)) != null; }

// --- convenience: per-workspace GitHub PAT + shared Basic-auth credential store ---
const patKey = (workspaceId) => `github_pat:${workspaceId}`;
export const getPat = (workspaceId) => getSecret(patKey(workspaceId));
export const setPat = (workspaceId, token) => (token ? setSecret(patKey(workspaceId), token) : deleteSecret(patKey(workspaceId)));
export const deletePat = (workspaceId) => deleteSecret(patKey(workspaceId));
export const getAuthDomains = () => getSecret('auth_domains', true).then((v) => v || []); // [{domain,username,password}]
export const setAuthDomains = (list) => setSecret('auth_domains', list);

// --- diagnostics (for the harness/test only) ---
export const _rawRecord = (id) => idbGet(VALS_STORE, id);
export const _wrappingKey = () => keyProvider.getWrappingKey();
