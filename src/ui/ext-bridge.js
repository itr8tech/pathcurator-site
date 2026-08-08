// src/ui/ext-bridge.js — P8: the app side of the extension bridge. Listens for the content
// script's announcements/pongs (window.postMessage, same-window + same-origin + nonce checked),
// and runs PAGE-DRIVEN CHUNKED audits: ≤40 URLs per request (MV3 SW lifetime: each chunk is one
// short event; a killed SW costs one retryable chunk), merging each chunk's results immediately
// through the existing mergeAuditResults (idempotent; overrides/exemptions already enforced by
// the worker and by listAuditUrls itself). Results are device-local by design.
const CHUNK = 15;                   // small chunks → real progress cadence + SW-lifetime headroom
// Worst case for one chunk is pathological but real: 15 dead links on ONE slow host = serial
// HEAD+GET timeouts ≈ 6 minutes. A short page-side timeout here caused a cascade in live testing:
// the page abandoned a still-running chunk, and every later chunk instantly failed "already
// running". Generous timeout + busy-retry below.
const CHUNK_TIMEOUT = 420000;

let extInfo = null;                 // { version, auditReady } once detected
const subscribers = new Set();
const pendingChunks = new Map();    // nonce → {resolve}

window.addEventListener('message', (ev) => {
  if (ev.source !== window || ev.origin !== location.origin) return;
  const d = ev.data;
  if (!d || typeof d !== 'object') return;
  if (d.pc === 'ext-pong') {
    extInfo = { version: d.version ?? null, auditReady: !!d.auditReady };
    for (const cb of subscribers) { try { cb(extInfo); } catch { /* subscriber's problem */ } }
  } else if (d.pc === 'ext-audit-result' && pendingChunks.has(d.nonce)) {
    pendingChunks.get(d.nonce).resolve(d);
    pendingChunks.delete(d.nonce);
  }
});

export const ping = () => window.postMessage({ pc: 'ext-ping', nonce: crypto.randomUUID() }, location.origin);
export const extensionInfo = () => extInfo;
export function onExtension(cb) {
  subscribers.add(cb);
  if (extInfo) cb(extInfo);
  ping();                                            // covers the content-script-announced-first race
  return () => subscribers.delete(cb);
}

function auditChunk(urls) {
  const nonce = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingChunks.has(nonce)) { pendingChunks.delete(nonce); resolve({ ok: false, error: 'Timed out waiting for the extension.', results: {} }); }
    }, CHUNK_TIMEOUT);
    pendingChunks.set(nonce, { resolve: (d) => { clearTimeout(timer); resolve(d); } });
    window.postMessage({ pc: 'ext-audit', nonce, urls }, location.origin);
  });
}

// Audit one workspace (null = pathways without a workspace). onProgress(done, total).
// PERMISSION-AWARE: without the broad fetch grant, cross-origin fetches fail INSTANTLY — merging
// those as "Blocked" would flood the audit view with garbage in seconds (seen in live testing).
// When the extension reports auditReady:false, failed verdicts (no real HTTP status) are NOT
// merged; they're counted as needsPermission so the UI can say exactly what to do. Real answers
// (e.g. same-origin/localhost, CORS-friendly hosts) still merge.
export async function runExtensionAudit(db, workspaceId, onProgress) {
  const list = await db.listAuditUrls(workspaceId);
  let done = 0, updated = 0, failedChunks = 0, lastError = null, needsPermission = 0;
  // Human-facing outcome tally (per URL, not per bookmark row — "updated" counts rows and reads
  // as nonsense when one URL lives in several bookmarks).
  const summary = { ok: 0, broken: 0, redirected: 0, auth: 0, unreachable: 0 };
  const tally = (r) => {
    if (r.httpStatus == null) summary.unreachable++;
    else if (r.requiresAuth) summary.auth++;
    else if (r.available === 0) summary.broken++;
    else if (r.redirectUrl) summary.redirected++;
    else summary.ok++;
  };
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    // If the extension is still busy on a previous chunk (e.g. after a page reload mid-run),
    // wait it out instead of hard-failing the rest of the run.
    let res = await auditChunk(chunk);
    for (let attempt = 0; attempt < 24 && !res.ok && /already running/i.test(res.error || ''); attempt++) {
      await new Promise((r) => setTimeout(r, 5000));
      res = await auditChunk(chunk);
    }
    if (!res.ok) { failedChunks++; lastError = res.error || 'Extension error.'; done += chunk.length; onProgress?.(done, list.length); continue; }
    const permitted = res.auditReady !== false;
    const results = {};
    for (const item of chunk) {
      const r = res.results[item.url_norm];
      if (!r) continue;
      if (!permitted && r.httpStatus == null) { needsPermission++; continue; }   // fetch denied, not a verdict
      results[item.url_norm] = r;
      tally(r);
    }
    if (Object.keys(results).length) {
      const m = await db.mergeAuditResults({ workspaceId, results, checkMethod: 'extension' });
      updated += m.updated;
    }
    done += chunk.length;
    onProgress?.(done, list.length);
  }
  return { total: list.length, updated, failedChunks, lastError, needsPermission, summary };
}
