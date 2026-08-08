// PathCurator v2 — main-thread DB facade (P1). The ONLY storage seam the UI imports.
// Coordinator-aware: the worker (single opfs-sahpool connection) is opened ONLY in the
// primary tab; reads from a follower are proxied to the primary; writes are primary-only
// and broadcast a change event. No SQL escapes the worker.
import { Coordinator } from './coordinator.js';
import * as secrets from './secrets.js';
import * as captureOutbox from './capture-outbox.js';

let worker = null;
let seq = 0;
const pending = new Map();
let coord = null;
let readyPromise = null;
const changeSubscribers = new Set();

function spawnWorker() {
  worker = new Worker('/src/data/db-worker.js', { type: 'module' });
  worker.onmessage = (e) => {
    const { id, ok, result, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    ok ? p.resolve(result) : p.reject(new Error(error));
  };
  worker.onerror = (e) => {
    for (const [, p] of pending) p.reject(new Error(e.message || 'worker error'));
    pending.clear();
  };
}

function workerRpc(op, args) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, op, args });
  });
}

// Called by the coordinator when THIS tab becomes primary: open + init the worker,
// then return the executor the coordinator uses for local reads/writes.
async function onPromote() {
  spawnWorker();
  await workerRpc('counts', { withMeta: true }); // forces worker init + migrations to finish
  // The capture_outbox drain is NOT here: main.js owns the triggers (promotion, /add signal,
  // foreground) so a follower promoted mid-session drains on the same path as a fresh primary.
  return (op, args) => workerRpc(op, args);
}

function init() {
  if (readyPromise) return readyPromise;
  coord = new Coordinator({
    onPromote,
    onChange: (evt) => { for (const cb of changeSubscribers) cb(evt); },
  });
  readyPromise = coord.start().then((role) => ({ role, isPrimary: coord.isPrimary }));
  return readyPromise;
}

const READ_OPS = new Set(['counts', 'listPathways', 'getWorkspaces', 'getPathwayDeep', 'exec',
  'getSetting', 'getAttachment',
  // P3 reads (serialize/getUncommittedCount are read-shaped; they never broadcast a change)
  'getWorkspaceFull', 'getSyncState', 'serializeWorkspace', 'getUncommittedCount', 'serializePathway',
  'getLocalHashes', 'hasAttachmentSha',
  // P4 inbox reads
  'listInbox', 'countInboxUnsorted',
  // P5 audit reads
  'listExemptDomains', 'listFlaggedBookmarks', 'serializeAuditOverrides', 'serializeExemptDomains',
  // P6 exports are read-shaped → followers can export too
  'exportPathwayData', 'exportWorkspaceData', 'exportBackupData', 'listAuditUrls']);
function call(op, args, change) {
  return init().then(() => (READ_OPS.has(op) ? coord.read(op, args) : coord.write(op, args, change)));
}

// PAT reads/writes + workspace creation touch main-thread secrets, which never reach the worker;
// gate them so a read-only follower can't mutate credentials or repo config.
function assertPrimary() {
  if (!coord?.isPrimary) throw new Error('This tab is read-only — PathCurator is active in another tab.');
}

// A queued CapturePayload → an inbox row (worker adds url_norm; the worker mints id if absent).
function toInboxRow(p) {
  return { id: crypto.randomUUID(), url: p.url, title: p.title ?? null, note: p.note ?? null,
    description: p.description ?? null, image_url: p.imageUrl ?? null, content_type: p.contentType || 'Read',
    source: p.source || 'manual', ref: p.ref, created_at: p.capturedAt ?? Date.now() };
}
// Move every queued capture from the IndexedDB outbox into the SQLite inbox. PRIMARY-only (a follower
// no-ops). Coalesced single-flight (mirrors router.js): a signal landing mid-drain runs one more pass.
// Crash-safe: the outbox row is removed ONLY after the inbox row is committed; a re-drain of the same
// ref is a no-op (addInboxItem uses ON CONFLICT(ref) DO NOTHING).
let draining = false, drainPending = false;
async function drainCaptureOutbox() {
  if (!coord?.isPrimary) return { drained: 0 };
  if (draining) { drainPending = true; return { drained: 0 }; }
  draining = true; drainPending = false;
  let n = 0;
  try {
    for (const p of await captureOutbox.drainAll()) {
      await call('addInboxItem', toInboxRow(p), { type: 'change', entity: 'inbox' });
      await captureOutbox.remove(p.ref);
      n++;
    }
  } finally {
    draining = false;
    if (drainPending) drainCaptureOutbox();
  }
  return { drained: n };
}

export const db = {
  async ready() {
    const r = await init();
    const counts = await coord.read('counts', { withMeta: true });
    return { ...r, meta: counts.meta, counts };
  },
  role: () => coord?.role ?? 'pending',
  isPrimary: () => !!coord?.isPrimary,
  onChange: (cb) => { changeSubscribers.add(cb); return () => changeSubscribers.delete(cb); },

  counts: () => call('counts'),
  listPathways: () => call('listPathways'),
  getWorkspaces: () => call('getWorkspaces'),
  getPathway: (id) => call('getPathwayDeep', id),
  getSetting: (key) => call('getSetting', key),
  getAttachment: (id) => call('getAttachment', id),
  exec: (sql, bind) => call('exec', { sql, bind }),                          // read

  // ---- writes (primary-only via coord.write; broadcast a change event) ----
  setSetting: (key, value) => call('setSetting', { key, value }, { type: 'change', entity: 'settings' }),
  createPathway: (a) => call('createPathway', a, { type: 'change', entity: 'pathways' }),
  updatePathway: (a) => call('updatePathway', a, { type: 'change', entity: 'pathways' }),
  deletePathway: (a) => call('deletePathway', a, { type: 'change', entity: 'pathways' }),
  createStep: (a) => call('createStep', a, { type: 'change', entity: 'steps' }),
  updateStep: (a) => call('updateStep', a, { type: 'change', entity: 'steps' }),
  deleteStep: (a) => call('deleteStep', a, { type: 'change', entity: 'steps' }),
  createBookmark: (a) => call('createBookmark', a, { type: 'change', entity: 'bookmarks' }),
  updateBookmark: (a) => call('updateBookmark', a, { type: 'change', entity: 'bookmarks' }),
  deleteBookmark: (a) => call('deleteBookmark', a, { type: 'change', entity: 'bookmarks' }),
  moveEntity: (a) => call('moveEntity', a, { type: 'change', entity: `${a.entity}s` }),
  setHeaderImage: (a) => call('setHeaderImage', a, { type: 'change', entity: 'pathways' }),
  removeHeaderImage: (a) => call('removeHeaderImage', a, { type: 'change', entity: 'pathways' }),
  renameWorkspace: (a) => call('renameWorkspace', a, { type: 'change', entity: 'workspaces' }),
  importWorkspace: (a) => call('importWorkspace', a, { type: 'change', entity: 'workspaces' }),
  reset: () => call('reset', undefined, { type: 'change', entity: '*' }),

  // ================= P3: GitHub sync =================
  // ---- reads ----
  getWorkspace: (id) => call('getWorkspaceFull', id),
  getSyncState: (id) => call('getSyncState', id),
  serializeWorkspace: (workspaceId, username = null, dateIso = null) =>
    call('serializeWorkspace', { workspaceId, modifiedBy: username, dateIso }),
  getUncommittedCount: (workspaceId) => call('getUncommittedCount', { workspaceId }),
  serializePathway: (id) => call('serializePathway', id),
  getLocalHashes: (workspaceId) => call('getLocalHashes', { workspaceId }),
  hasAttachmentSha: (sha) => call('hasAttachmentSha', sha),
  applyPull: (a) => call('applyPull', a, { type: 'change', entity: 'pathways' }),
  // P6: converted-legacy import into an existing workspace → '*' so dashboard + sync status refresh
  importPathwaysIntoWorkspace: (a) => call('importPathwaysIntoWorkspace', a, { type: 'change', entity: '*' }),
  exportPathwayData: (id) => call('exportPathwayData', { id }),
  exportWorkspaceData: (workspaceId) => call('exportWorkspaceData', { workspaceId }),
  exportBackupData: () => call('exportBackupData'),

  // ================= P4: capture inbox =================
  drainCaptureOutbox: () => drainCaptureOutbox(),
  listInbox: (status = 'unsorted') => call('listInbox', { status }),
  countInboxUnsorted: () => call('countInboxUnsorted'),
  addInboxItem: (row) => call('addInboxItem', row, { type: 'change', entity: 'inbox' }),
  updateInboxStatus: (a) => call('updateInboxStatus', a, { type: 'change', entity: 'inbox' }),
  deleteInboxItem: (a) => call('deleteInboxItem', a, { type: 'change', entity: 'inbox' }),
  // triage creates a bookmark AND changes the inbox → '*' so the inbox badge, sync status, and any
  // open pathway view all refresh (a plain 'inbox' change wouldn't wake the sync layer).
  triageInboxItem: (a) => call('triageInboxItem', a, { type: 'change', entity: '*' }),
  addToInboxManually: ({ url, title = null, note = null, content_type = 'Read' }) =>
    call('addInboxItem', { id: crypto.randomUUID(), url, title, note, description: null, image_url: null,
      content_type, source: 'manual', ref: `manual:${crypto.randomUUID()}`, created_at: Date.now() },
      { type: 'change', entity: 'inbox' }),

  // ================= P5: link audit =================
  mergeAuditResults: (a) => call('mergeAuditResults', a, { type: 'change', entity: 'bookmarks' }),
  listExemptDomains: () => call('listExemptDomains'),
  addExemptDomain: (a) => call('addExemptDomain', a, { type: 'change', entity: 'bookmarks' }),
  removeExemptDomain: (a) => call('removeExemptDomain', a, { type: 'change', entity: 'bookmarks' }),
  listFlaggedBookmarks: () => call('listFlaggedBookmarks'),
  setBookmarkAuditStatus: (a) => call('setBookmarkAuditStatus', a, { type: 'change', entity: 'bookmarks' }),
  serializeAuditOverrides: (workspaceId) => call('serializeAuditOverrides', { workspaceId }),
  mergeAuditOverrides: (a) => call('mergeAuditOverrides', a, { type: 'change', entity: 'bookmarks' }),
  serializeExemptDomains: () => call('serializeExemptDomains'),
  listAuditUrls: (workspaceId = null) => call('listAuditUrls', { workspaceId }),
  mergeExemptDomains: (a) => call('mergeExemptDomains', a, { type: 'change', entity: 'bookmarks' }),

  // ---- sync-state writes (broadcast 'sync' so the indicator refreshes but views don't churn) ----
  setSyncState: (workspaceId, state) => call('setSyncState', { workspaceId, state }, { type: 'change', entity: 'sync' }),
  markCommitted: (a) => call('markCommitted', a, { type: 'change', entity: 'sync' }),

  // ---- PAT lifecycle (main-thread secrets; primary-only for writes/reads-of-token) ----
  hasWorkspacePat: (id) => secrets.getPat(id).then((t) => !!t),
  getWorkspacePat: (id) => { assertPrimary(); return secrets.getPat(id); },
  deleteWorkspacePat: (id) => { assertPrimary(); return secrets.deletePat(id); },

  // ---- workspace lifecycle (repo config + PAT together) ----
  // PAT is stored FIRST, keyed by a caller-generated id, then the row is inserted; the PAT is
  // rolled back if the insert fails so no orphan secret is left behind.
  async createWorkspace({ token = null, org_label, owner = null, repo = null, branch = 'main', path = '', username = null, colour = null }) {
    assertPrimary();
    const id = crypto.randomUUID();
    if (token) await secrets.setPat(id, token);
    try {
      return await call('createWorkspace', { id, org_label, owner, repo, branch, path, username, colour }, { type: 'change', entity: 'workspaces' });
    } catch (e) {
      if (token) await secrets.deletePat(id).catch(() => {});
      throw e;
    }
  },
  async setWorkspaceRepo({ id, token = undefined, owner = null, repo = null, branch = 'main', path = '', username = null, org_label = null, colour = null }) {
    assertPrimary();
    if (token !== undefined && token !== null) await secrets.setPat(id, token);
    return call('setWorkspaceRepo', { id, owner, repo, branch, path, username, org_label, colour }, { type: 'change', entity: 'workspaces' });
  },
  setWorkspaceUsername: (id, username) => call('setWorkspaceRepoMeta', { id, username }, { type: 'change', entity: 'workspaces' }),
  async disconnectWorkspaceRepo({ id }) {          // keep pathways; clear coords + PAT + sync baseline
    assertPrimary();
    const r = await call('setWorkspaceRepo', { id, owner: null, repo: null, branch: 'main', path: '', username: null, org_label: null, colour: null }, { type: 'change', entity: 'workspaces' });
    await secrets.deletePat(id).catch(() => {});
    return r;
  },
  async deleteWorkspace({ id }) {                  // cascade pathways (worker) + drop the PAT (secrets)
    assertPrimary();
    const r = await call('deleteWorkspace', { id }, { type: 'change', entity: 'workspaces' });
    await secrets.deletePat(id).catch(() => {});
    return r;
  },
};
