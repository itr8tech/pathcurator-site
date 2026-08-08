// PathCurator v2 — sync orchestrator (P3, main thread, PRIMARY tab only).
// Ties the GitHub client + worker serialize/merge + secrets together: connect, initialize,
// commit (atomic Git Trees, NO silent clobber), pull (Step 6), and a per-workspace status cache.
// Never force-pushes: a commit that would overwrite a teammate's newer state stops and reports
// `remote-ahead` for the merge flow.
import { isConflict } from './github.js';
import { buildPlan, resolutionToAction, nonInteractiveAction } from './merge.js';
import { contentHash, manifestHashOf, workspaceHashOf } from './canonical.js';
import { convertLegacyPathways, LEGACY_FILE } from './legacy.js';

const READONLY = 'This tab is read-only — PathCurator is active in another tab.';

const joinPath = (base, p) => (base ? `${String(base).replace(/\/+$/, '')}/${p}` : p);

// Uint8Array → base64 (chunked; a spread would overflow the stack on ~100 KB+ packages).
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
// P10 1b: the per-pathway "keep a SCORM package published in the repo" opt-in lives in settings.
const PUBLISH_KEY = (pathwayId) => `publish_scorm:${pathwayId}`;
const packagePath = (P, pathwayId) => joinPath(P, `packages/${pathwayId}.zip`);

// P5: the committed audit/overrides.json is compared via a STABLE string (sorted URLs, fixed entry
// field order), so JSON key order can never fake a difference.
const stableOverrides = (o = {}) => JSON.stringify(Object.keys(o).sort().map((u) => [u, o[u]?.available ? 1 : 0, o[u]?.method, o[u]?.setAt]));
// Same for the exemption list ([{domain, reason}]) committed in audit/config.json.
const stableExempt = (list = []) => JSON.stringify((list || []).map((e) => [e.domain, e.reason || '']).sort());
// audit/config.json ⇄ exemption list. exemptDomains stays a plain string[] — the DEPLOYED checkers
// read it that way — with reasons in a parallel app-only map.
const exemptFromConfig = (cfg) => (Array.isArray(cfg?.exemptDomains) ? cfg.exemptDomains : [])
  .map((d) => ({ domain: String(d).toLowerCase(), reason: String(cfg?.exemptReasons?.[String(d).toLowerCase()] ?? '') }));
const exemptIntoConfig = (cfg, list) => ({
  ...(cfg && typeof cfg === 'object' ? cfg : {}),          // preserve unknown keys (e.g. timeoutMs)
  exemptDomains: list.map((e) => e.domain),
  exemptReasons: Object.fromEntries(list.filter((e) => e.reason).map((e) => [e.domain, e.reason])),
});

function defaultMessage(ser) {
  if (!ser.baseCommitSha) return 'Initialize PathCurator workspace';
  const bits = [];
  if (ser.changedCount) bits.push(`update ${ser.changedCount} pathway${ser.changedCount === 1 ? '' : 's'}`);
  if (ser.deletedCount) bits.push(`remove ${ser.deletedCount} pathway${ser.deletedCount === 1 ? '' : 's'}`);
  if (!bits.length && ser.manifestChanged) bits.push('reorder pathways');
  const s = bits.join(', ');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Update PathCurator workspace';
}

export function createSync({ db, secrets, makeClient, isPrimary, now = () => Date.now(), buildScormPackage = null }) {
  const statusByWs = new Map();          // wsId → derived status object
  const conflicts = new Map();           // wsId → remote sha (or null) when a clobber was averted
  const pendingPull = new Map();         // wsId → pull context awaiting interactive review
  const subscribers = new Set();
  const lastAuto = new Map();            // wsId → last auto-commit time
  let autoTimer = null;

  const snapshot = () => [...statusByWs.values()];
  const notify = (wsId) => { for (const cb of subscribers) { try { cb(wsId, statusByWs.get(wsId)); } catch { /* subscriber error is not our problem */ } } };
  const markConflict = (wsId, remoteSha) => { conflicts.set(wsId, remoteSha ?? null); };
  const clearConflict = (wsId) => { conflicts.delete(wsId); };

  // P5: overrides side-channel state — the last-synced committed audit/overrides.json (+ its blob
  // sha), stored OUTSIDE sync_state (which commit/pull rebuild). It is the "base" of the three-way
  // overrides merge and the reference for "are there override changes to commit?".
  const OV_KEY = (wsId) => `audit_overrides_state:${wsId}`;
  const EX_KEY = (wsId) => `audit_config_state:${wsId}`;   // last-synced audit/config.json (+ blob sha)
  async function getOverridesState(wsId) {
    try { return JSON.parse((await db.getSetting(OV_KEY(wsId))) || 'null'); } catch { return null; }
  }
  async function getExemptState(wsId) {
    try { return JSON.parse((await db.getSetting(EX_KEY(wsId))) || 'null'); } catch { return null; }
  }
  // "Audit-dirty" = override changes OR exemption changes since the last sync — both ride commits.
  async function auditOverridesDirty(wsId) {
    try {
      const ser = await db.serializeAuditOverrides(wsId);
      if (stableOverrides(ser.overrides) !== stableOverrides((await getOverridesState(wsId))?.overrides || {})) return true;
      const ex = await db.serializeExemptDomains();
      return stableExempt(ex.exempt) !== stableExempt((await getExemptState(wsId))?.exempt || []);
    } catch { return false; }
  }

  async function computeStatus(wsId) {
    const ws = await db.getWorkspace(wsId);
    const connected = !!(ws && ws.owner && ws.repo);
    const hasPat = await db.hasWorkspacePat(wsId);
    const state = connected ? await db.getSyncState(wsId) : null;
    let uc = { total: 0, changed: 0, deleted: 0, changedPathwayIds: [], removedPathwayIds: [] };
    if (connected) uc = await db.getUncommittedCount(wsId);
    const auditDirty = connected ? await auditOverridesDirty(wsId) : false;
    const conflict = conflicts.has(wsId);
    let s = 'disconnected';
    if (connected) {
      if (conflict) s = 'conflict';
      else if (!state) s = 'never-committed';
      else s = uc.total > 0 ? 'dirty' : 'clean';
    }
    return {
      wsId, orgLabel: ws?.org_label ?? '', owner: ws?.owner ?? null, repo: ws?.repo ?? null,
      connected, hasPat, primary: isPrimary(),
      state: s, dirty: uc.total > 0, uncommittedCount: uc.total, auditDirty,
      changedPathwayIds: uc.changedPathwayIds || [], removedPathwayIds: uc.removedPathwayIds || [],
      lastCommitSha: state?.lastCommitSha ?? null, lastCommitTime: state?.lastSyncedAt ?? null,
      remoteAhead: conflict, remoteSha: conflict ? conflicts.get(wsId) : null,
    };
  }

  async function refreshOne(wsId) {
    const st = await computeStatus(wsId);
    statusByWs.set(wsId, st);
    notify(wsId);
    return st;
  }
  async function refreshAll() {
    const list = await db.getWorkspaces();
    await Promise.all(list.map((w) => refreshOne(w.id)));
    return snapshot();
  }

  // The atomic, no-silent-clobber commit. Works for the first commit (empty repo) too.
  async function commit(wsId, { message, publishNow = null } = {}) {
    if (!isPrimary()) throw new Error(READONLY);
    const ws = await db.getWorkspace(wsId);
    if (!ws || !ws.owner || !ws.repo) throw new Error('This workspace is not connected to a repo.');
    const token = await db.getWorkspacePat(wsId);
    if (!token) throw new Error('No access token is stored for this workspace.');
    const client = makeClient(ws, token);

    // Attribution: resolve the PAT's login once, before serialize, so file + DB agree.
    if (!ws.username) {
      const login = (await client.getUser().catch(() => null))?.login;
      if (login) { await db.setWorkspaceUsername(wsId, login); ws.username = login; }
    }

    const prior = (await db.getSyncState(wsId))?.files || {};
    const ser = await db.serializeWorkspace(wsId, ws.username);
    // P5: audit-side changes commit too — overrides AND exemptions ride along with content commits
    // AND justify a commit of their own (zero content edits).
    const ovSer = await db.serializeAuditOverrides(wsId);
    const ovChanged = stableOverrides(ovSer.overrides) !== stableOverrides((await getOverridesState(wsId))?.overrides || {});
    const exSer = await db.serializeExemptDomains();
    const exChanged = stableExempt(exSer.exempt) !== stableExempt((await getExemptState(wsId))?.exempt || []);
    const contentChanged = !!(ser.changedCount || ser.deletedCount || ser.manifestChanged);
    if (!contentChanged && !ovChanged && !exChanged && !publishNow) {
      await refreshOne(wsId);
      return { ok: true, committed: false, reason: 'no-changes' };
    }

    // GUARD 1 — remote HEAD must equal the base we serialized against.
    const ref = await client.getRef();               // null = empty/uninitialized repo
    if (ref && ser.baseCommitSha && ref.sha !== ser.baseCommitSha) {
      markConflict(wsId, ref.sha);
      await refreshOne(wsId);
      return { ok: false, committed: false, reason: 'remote-ahead', remoteSha: ref.sha };
    }
    const baseCommit = ref ? await client.getCommit(ref.sha) : null;
    const P = ser.workspacePath;

    // Minimal tree: only changed files become new blobs; unchanged files ride base_tree.
    const entries = [];
    for (const img of ser.images) {
      const sha = await client.createBlob({ content: img.bytesBase64, encoding: 'base64' });
      entries.push({ path: joinPath(P, img.path), mode: '100644', type: 'blob', sha });
    }
    const fileBlobShas = {};
    for (const f of ser.files) {
      const sha = await client.createBlob({ content: f.content, encoding: 'utf-8' });
      fileBlobShas[f.pathwayId] = sha;
      entries.push({ path: joinPath(P, f.path), mode: '100644', type: 'blob', sha });
    }
    if (ser.manifestChanged || !ref) {
      const sha = await client.createBlob({ content: ser.manifestBytes, encoding: 'utf-8' });
      entries.push({ path: joinPath(P, 'manifest.json'), mode: '100644', type: 'blob', sha });
    }
    // Deletion entries STILL require mode+type — the real Trees API rejects a bare
    // { path, sha:null } with "Must supply a valid tree.mode".
    for (const del of ser.deletions) entries.push({ path: joinPath(P, del), mode: '100644', type: 'blob', sha: null });
    let ovBlobSha = null;
    if (ovChanged) {
      ovBlobSha = await client.createBlob({
        content: JSON.stringify({ schemaVersion: 1, updatedAt: now(), overrides: ovSer.overrides }, null, 2) + '\n',
        encoding: 'utf-8' });
      entries.push({ path: joinPath(P, 'audit/overrides.json'), mode: '100644', type: 'blob', sha: ovBlobSha });
    }
    let exBlobSha = null;
    if (exChanged) {
      // Merge into the EXISTING committed config so hand-set keys (timeoutMs, …) survive.
      let existing = null;
      if (baseCommit) {
        try {
          const t = await client.getTree(baseCommit.treeSha);
          const e = (t.tree || []).find((x) => x.type === 'blob' && x.path === joinPath(P, 'audit/config.json'));
          if (e) existing = await client.getBlobJson(e.sha);
        } catch { /* unreadable/absent → fresh file */ }
      }
      exBlobSha = await client.createBlob({
        content: JSON.stringify(exemptIntoConfig(existing, exSer.exempt), null, 2) + '\n', encoding: 'utf-8' });
      entries.push({ path: joinPath(P, 'audit/config.json'), mode: '100644', type: 'blob', sha: exBlobSha });
    }

    // P10 1b: published SCORM packages ride the same commit — side files like the audit channel,
    // hash-excluded, so they can never dirty a pathway. Rebuilt ONLY for opted-in pathways that
    // CHANGED in this commit (or an explicit publishNow) — packages never churn without content
    // movement. Moodle activities pointed at the package URL then auto-update on their own cron.
    let publishedCount = 0;
    if (buildScormPackage) {
      const changedIds = new Set(Object.keys(ser.pathwayHashes).filter((id) => prior[id]?.contentHash !== ser.pathwayHashes[id]));
      const wanted = new Set();
      for (const id of Object.keys(ser.pathwayHashes)) {
        if (changedIds.has(id) && (await db.getSetting(PUBLISH_KEY(id))) === '1') wanted.add(id);
      }
      if (publishNow && ser.pathwayHashes[publishNow]) wanted.add(publishNow);
      for (const id of wanted) {
        const pkg = await buildScormPackage(id);
        const sha = await client.createBlob({ content: bytesToBase64(pkg.content), encoding: 'base64' });
        entries.push({ path: packagePath(P, id), mode: '100644', type: 'blob', sha });
        publishedCount++;
      }
    }

    const treeSha = await client.createTree({ baseTreeSha: baseCommit?.treeSha, entries });
    const commitMessage = message || (contentChanged ? defaultMessage(ser)
      : publishedCount ? `Publish SCORM package${publishedCount === 1 ? '' : 's'}` : 'Update audit settings');
    const commitSha = await client.createCommit({
      message: commitMessage, treeSha, parents: ref ? [ref.sha] : [] });

    // GUARD 2 — force:false so a race between preflight and here is rejected (422 → ConflictError).
    try {
      if (ref) await client.updateRef({ sha: commitSha, force: false });
      else await client.createRef({ sha: commitSha });
    } catch (e) {
      if (isConflict(e)) { markConflict(wsId, null); await refreshOne(wsId); return { ok: false, committed: false, reason: 'remote-ahead' }; }
      throw e;
    }

    // Persist ONLY after the ref advanced. Build the unified files map (prior ∪ changed − deleted).
    const filesMap = {};
    for (const id in ser.pathwayHashes) {
      filesMap[id] = { contentHash: ser.pathwayHashes[id], blobSha: fileBlobShas[id] || prior[id]?.blobSha || null };
    }
    await db.markCommitted({
      workspaceId: wsId, commitSha, treeSha, committedAt: now(),
      pathwayVersions: ser.pathwayVersions, manifestHash: ser.manifestHash,
      workspaceHash: ser.workspaceHash, files: filesMap,
    });
    if (ovChanged) await db.setSetting(OV_KEY(wsId), JSON.stringify({ sha: ovBlobSha, overrides: ovSer.overrides }));
    if (exChanged) await db.setSetting(EX_KEY(wsId), JSON.stringify({ sha: exBlobSha, exempt: exSer.exempt }));
    clearConflict(wsId);
    await refreshOne(wsId);
    await recordSyncAction(wsId, { type: 'commit', message: commitMessage, changed: ser.changedCount, deleted: ser.deletedCount, sha: commitSha });
    return { ok: true, committed: true, commitSha, changed: ser.changedCount, deleted: ser.deletedCount, published: publishedCount };
  }

  // P10 1b: the publish surface for the UI. Info is a cheap repo probe (does packages/<id>.zip
  // exist, and what URL does Moodle need); publishScorm is a commit carrying (at least) the
  // package — callers should ensure the workspace is otherwise clean so nothing rides uninvited.
  async function scormPublishInfo(wsId, pathwayId) {
    const ws = await db.getWorkspace(wsId);
    if (!ws?.owner || !ws.repo) return null;
    const token = await db.getWorkspacePat(wsId);
    if (!token) return null;
    const client = makeClient(ws, token);
    const br = ws.branch || 'main';
    const path = packagePath(ws.path || '', pathwayId);
    const head = await client.headFile(ws.owner, ws.repo, path, br);
    const repoPrivate = (await client.getRepoMeta().catch(() => null))?.private ?? null;   // null = unknown
    return { exists: head.exists, path, repoPrivate,
      enabled: (await db.getSetting(PUBLISH_KEY(pathwayId))) === '1',
      url: `https://raw.githubusercontent.com/${ws.owner}/${ws.repo}/${br}/${path}` };
  }
  const setScormPublish = (pathwayId, on) => db.setSetting(PUBLISH_KEY(pathwayId), on ? '1' : '0');
  const publishScorm = (wsId, pathwayId) => commit(wsId, { publishNow: pathwayId });

  // #/sync: remember the last commit/pull performed FROM THIS BROWSER, at action time — showing
  // "when did I last sync" must not need a network round-trip. Cosmetic; failures never surface.
  async function recordSyncAction(wsId, info) {
    try { await db.setSetting(`sync_last_action:${wsId}`, JSON.stringify({ at: now(), ...info })); } catch { /* cosmetic */ }
  }

  // #/sync: what the repository's HEAD looks like right now (message/author/date), plus whether
  // this device has already pulled it. Read-only, best-effort — the overview fills it in async.
  async function remoteHead(wsId) {
    const ws = await db.getWorkspace(wsId);
    if (!ws?.owner || !ws.repo) return null;
    const token = await db.getWorkspacePat(wsId);
    if (!token) return null;
    const client = makeClient(ws, token);
    const ref = await client.getRef();
    if (!ref) return null;
    const meta = await client.getCommitMeta(ref.sha);
    const state = await db.getSyncState(wsId);
    return { ...meta, pulled: state?.lastCommitSha === ref.sha,
      url: `https://github.com/${ws.owner}/${ws.repo}/commit/${ref.sha}` };
  }

  // Initialize = the first commit of a (usually empty) repo. commit() already handles ref==null.
  const initialize = (wsId, opts = {}) => commit(wsId, { message: opts.message || 'Initialize PathCurator workspace' });

  // ===== auto-commit (OFF by default, per-workspace opt-in, primary-only, NEVER force-pushes) =====
  async function getAutoCommit(wsId) {
    try { const v = JSON.parse(await db.getSetting(`auto_commit:${wsId}`)); return { enabled: !!v.enabled, intervalMs: v.intervalMs || 300000 }; }
    catch { return { enabled: false, intervalMs: 300000 }; }
  }
  async function setAutoCommit(wsId, { enabled, intervalMs = 300000 } = {}) {
    await db.setSetting(`auto_commit:${wsId}`, JSON.stringify({ enabled: !!enabled, intervalMs }));
    return refreshOne(wsId);
  }
  async function autoTick() {
    if (!isPrimary()) return;
    for (const w of await db.getWorkspaces()) {
      if (!(w.owner && w.repo) || conflicts.has(w.id)) continue;         // never retry through a conflict
      const cfg = await getAutoCommit(w.id);
      if (!cfg.enabled) continue;
      if (now() - (lastAuto.get(w.id) || 0) < (cfg.intervalMs || 300000)) continue;
      if ((await db.getUncommittedCount(w.id)).total <= 0 && !(await auditOverridesDirty(w.id))) continue;
      lastAuto.set(w.id, now());
      try { await commit(w.id, {}); } catch { /* status reflects the failure; commit() never force-pushes */ }
    }
  }
  function startTimers() { stopTimers(); if (isPrimary()) autoTimer = setInterval(() => autoTick().catch(() => {}), 30000); }
  function stopTimers() { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } }

  // An apply decision from a classified item (auto or non-interactive). null = keep-local/noop.
  const toDecision = (item, remoteObjs) => {
    if (item.autoAction === 'add' || item.autoAction === 'replace') return { id: item.id, action: item.autoAction, obj: remoteObjs[item.id] };
    if (item.autoAction === 'delete-local') return { id: item.id, action: 'delete' };
    return null;
  };

  async function applyAndAdvance(wsId, context, decisions) {
    const res = await db.applyPull({
      workspaceId: wsId, decisions, remoteOrder: context.remoteOrder, images: context.images,
      commitSha: context.commitSha, treeSha: context.treeSha,
      filesMap: context.filesMap, manifestHash: context.manifestHash, workspaceHash: context.workspaceHash,
    });
    // P5: content is applied → the bookmarks exist → merge the audit side-channel now (hash-excluded,
    // so it never affects the content/conflict state we just wrote).
    if (context.auditMerge) {
      try {
        await db.mergeAuditResults({ workspaceId: wsId, results: context.auditMerge.results, checkMethod: context.auditMerge.checkMethod });
        await db.setSetting(`audit_state:${wsId}`, JSON.stringify({ resultsSha: context.auditMerge.sha }));
      } catch (e) { console.warn('[sync] audit merge skipped:', e?.message || e); }
    }
    // Overrides AFTER results: on a fresh device the checker's verdicts land first, then any
    // committed override wins over them — same precedence a long-lived device already has.
    if (context.overridesMerge) {
      try {
        const om = context.overridesMerge;
        const res = await db.mergeAuditOverrides({ workspaceId: wsId, remote: om.overrides, base: om.base });
        await db.setSetting(OV_KEY(wsId), JSON.stringify({ sha: om.sha, overrides: res.normalized }));
      } catch (e) { console.warn('[sync] audit overrides merge skipped:', e?.message || e); }
    }
    if (context.exemptMerge) {
      try {
        const em = context.exemptMerge;
        const res = await db.mergeExemptDomains({ remote: em.remote, base: em.base });
        await db.setSetting(EX_KEY(wsId), JSON.stringify({ sha: em.sha, exempt: res.normalized }));
      } catch (e) { console.warn('[sync] exempt merge skipped:', e?.message || e); }
    }
    clearConflict(wsId);
    await refreshOne(wsId);
    return res;
  }

  // Pull remote → classify by stable id → auto-apply the safe cases; any TRUE conflict is held for
  // interactive review (locked "always review"). interactive:false (unattended) keeps local on conflict.
  async function pull(wsId, { interactive = true } = {}) {
    if (!isPrimary()) throw new Error(READONLY);
    const ws = await db.getWorkspace(wsId);
    if (!ws || !ws.owner || !ws.repo) throw new Error('This workspace is not connected to a repo.');
    const token = await db.getWorkspacePat(wsId);
    if (!token) throw new Error('No access token is stored for this workspace.');
    const client = makeClient(ws, token);
    const P = ws.path || '';

    const ref = await client.getRef();
    if (!ref) return { ok: true, upToDate: true, empty: true };
    const state = await db.getSyncState(wsId);
    if (state?.lastCommitSha === ref.sha) {
      await recordSyncAction(wsId, { type: 'pull', upToDate: true });
      // Remote hasn't moved — but if this workspace is still EMPTY, check for an unmigrated legacy
      // file anyway. (The stub-manifest state — an empty v2 layout committed next to
      // curator-pathways.json — would otherwise sit "in sync" forever with no import offer.)
      let legacy = null;
      try {
        if (!Object.keys(await db.getLocalHashes(wsId)).length) {
          const t = await client.getTree((await client.getCommit(ref.sha)).treeSha);
          const e = (t.tree || []).find((x) => x.type === 'blob' && x.path === joinPath(P, LEGACY_FILE));
          if (e) legacy = { sha: e.sha };
        }
      } catch { /* best-effort — never block the up-to-date answer */ }
      return { ok: true, upToDate: true, ...(legacy ? { legacy } : {}) };
    }
    const baseFiles = state?.files || {};
    const firstImport = !state;             // never synced → this pull IS the import (no baseline)

    const commit = await client.getCommit(ref.sha);
    const tree = await client.getTree(commit.treeSha);
    if (tree.truncated) throw new Error('Remote tree is too large to read in one request.');
    const pathToSha = new Map();
    for (const e of tree.tree) if (e.type === 'blob') pathToSha.set(e.path, e.sha);

    // P6: a legacy single-file repo (curator-pathways.json). No v2 manifest at all → the pull can't
    // proceed, but the honest answer is "legacy repo — offer the import", not "no-manifest".
    const legacySha = pathToSha.get(joinPath(P, LEGACY_FILE)) || null;
    const manifestSha = pathToSha.get(joinPath(P, 'manifest.json'));
    if (!manifestSha) {
      if (legacySha) return { ok: true, legacyOnly: true, legacy: { sha: legacySha } };
      return { ok: false, reason: 'no-manifest' };
    }
    const manifest = await client.getBlobJson(manifestSha);
    const remoteIndex = (manifest.pathways || []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const remoteOrder = remoteIndex.map((e) => e.id);
    // v2 manifest present but EMPTY beside a legacy file (the stub-manifest state) → same offer.
    const legacyOffer = legacySha && !remoteIndex.length ? { sha: legacySha } : null;

    // P5: FETCH the audit results side-channel here (once, if its sha moved), but MERGE it only AFTER
    // the content is applied — the bookmarks it keys on must exist first. Its sha lives in a SEPARATE
    // settings key: sync_state is rebuilt by commit/pull and would clobber it. Best-effort — a
    // bad/absent results file never blocks the content pull.
    let auditMerge = null;
    const auditSha = pathToSha.get(joinPath(P, 'audit/results.json'));
    if (auditSha) {
      let prevSha = null;
      try { prevSha = JSON.parse((await db.getSetting(`audit_state:${wsId}`)) || '{}').resultsSha; } catch { /* first run */ }
      if (auditSha !== prevSha) {
        try { const af = await client.getBlobJson(auditSha); auditMerge = { sha: auditSha, results: af?.results || {}, checkMethod: af?.checkMethod || 'github-action' }; }
        catch (e) { console.warn('[sync] audit results skipped:', e?.message || e); }
      }
    }
    // P5: the overrides side-channel — fetched when its blob moved (or the file was deleted
    // remotely), merged three-way after content+results apply. base = the file as of the last sync,
    // so this device's uncommitted override edits survive and remote "Auto" clears propagate.
    let overridesMerge = null;
    {
      const ovSha = pathToSha.get(joinPath(P, 'audit/overrides.json')) || null;
      const ovState = await getOverridesState(wsId);
      if (ovSha !== (ovState?.sha ?? null)) {
        if (!ovSha) overridesMerge = { sha: null, overrides: {}, base: ovState?.overrides || {} };
        else {
          try { const f = await client.getBlobJson(ovSha); overridesMerge = { sha: ovSha, overrides: f?.overrides || {}, base: ovState?.overrides || {} }; }
          catch (e) { console.warn('[sync] audit overrides skipped:', e?.message || e); }
        }
      }
    }
    // P5: exemptions travel too (audit/config.json) — same three-way, per domain, into the global list.
    let exemptMerge = null;
    {
      const exSha = pathToSha.get(joinPath(P, 'audit/config.json')) || null;
      const exState = await getExemptState(wsId);
      if (exSha !== (exState?.sha ?? null)) {
        if (!exSha) exemptMerge = { sha: null, remote: [], base: exState?.exempt || [] };
        else {
          try { const f = await client.getBlobJson(exSha); exemptMerge = { sha: exSha, remote: exemptFromConfig(f), base: exState?.exempt || [] }; }
          catch (e) { console.warn('[sync] audit config skipped:', e?.message || e); }
        }
      }
    }

    // Fetch ONLY changed pathway blobs; unchanged ones reuse the base hash (no refetch).
    const remoteObjs = {}, remoteHashes = {}, remoteBlobShas = {};
    for (const e of remoteIndex) {
      const sha = pathToSha.get(joinPath(P, `pathways/${e.id}.json`));
      if (!sha) continue;
      remoteBlobShas[e.id] = sha;
      if (baseFiles[e.id]?.blobSha === sha) { remoteHashes[e.id] = baseFiles[e.id].contentHash; continue; }
      const obj = await client.getBlobJson(sha);
      remoteObjs[e.id] = obj;
      remoteHashes[e.id] = await contentHash(obj.pathway);
    }

    // Fetch header-image blobs for changed pathways whose bytes aren't already stored locally
    // (dedup by content sha256). Only changed pathway objects were fetched above, and an image
    // swap changes the pathway file (canonical hash includes header_image.sha256), so this covers
    // every case an image could have moved. Unchanged pathways keep their existing local image.
    const images = {};
    for (const id in remoteObjs) {
      const hi = remoteObjs[id]?.pathway?.header_image;
      if (!hi?.sha256 || !hi.file || images[hi.sha256]) continue;
      if (await db.hasAttachmentSha(hi.sha256)) continue;                 // already present locally
      const gitSha = pathToSha.get(joinPath(P, hi.file));
      if (!gitSha) continue;                                              // referenced blob missing from tree
      images[hi.sha256] = { bytes: await client.getBlobBytes(gitSha), mime: hi.mime, ext: hi.ext };
    }

    const localHashes = await db.getLocalHashes(wsId);
    const ids = new Set([...Object.keys(localHashes), ...Object.keys(remoteHashes), ...Object.keys(baseFiles)]);
    let plan = buildPlan([...ids].map((id) => ({ id, local: localHashes[id], remote: remoteHashes[id], base: baseFiles[id]?.contentHash })));

    // First sync after connecting an existing repo: this pull IS the import. With no baseline there
    // is nothing to conflict against, so a pathway present on both sides takes the repo's version
    // (a same-id collision on a never-synced workspace is shared-origin content — e.g. the seed —
    // being adopted from the repo). Device-only pathways are kept and become uncommitted. This
    // stops a fresh connect from surfacing every shared pathway as a two-sided "conflict".
    if (firstImport && plan.review.length) {
      const promoted = plan.review.map((i) => ({ ...i, status: 'imported', autoAction: 'replace', review: false }));
      const byId = new Map(promoted.map((i) => [i.id, i]));
      plan = { ...plan, items: plan.items.map((i) => byId.get(i.id) || i),
        auto: [...plan.auto, ...promoted], review: [], needsReview: false };
    }

    const manifestHash = await manifestHashOf(remoteIndex.map((e) => ({ id: e.id, sort_order: e.sort_order, name: e.name })));
    const workspaceHash = await workspaceHashOf(manifestHash, remoteHashes);
    const filesMap = {};
    for (const id in remoteHashes) filesMap[id] = { contentHash: remoteHashes[id], blobSha: remoteBlobShas[id] };
    const context = { wsId, plan, remoteObjs, remoteOrder, images, auditMerge, overridesMerge, exemptMerge, commitSha: ref.sha, treeSha: commit.treeSha, filesMap, manifestHash, workspaceHash };

    if (plan.needsReview && interactive) {
      pendingPull.set(wsId, context);
      await refreshOne(wsId);
      return { ok: true, needsReview: true, plan };
    }
    const decisions = [
      ...plan.auto.map((i) => toDecision(i, remoteObjs)),
      ...plan.review.map((i) => toDecision({ ...i, autoAction: nonInteractiveAction(i) }, remoteObjs)),
    ].filter(Boolean);
    const applied = await applyAndAdvance(wsId, context, decisions);
    return { ok: true, needsReview: false, applied, plan, ...(legacyOffer ? { legacy: legacyOffer } : {}) };
  }

  // P5: install (or update) the link-audit tooling in the workspace's repo — the checker, the Issue
  // notifier, and the Action workflow — from THIS app's own served copies, in one atomic commit on
  // top of head (no force). Files go to the REPO ROOT regardless of the workspace path: the
  // workflow scans every manifest.json recursively and writes each root's audit/results.json.
  // Idempotent (unchanged tree → no commit). Tokens without the Workflows permission can't push
  // .github/workflows/ files — on rejection we retry with just the scripts and report
  // workflowSkipped so the UI can say what's missing.
  const AUDIT_TOOLING = [
    { src: '/audit/audit.mjs', dest: 'audit/audit.mjs' },
    { src: '/audit/notify.mjs', dest: 'audit/notify.mjs' },
    { src: '/audit/workflow.yml', dest: '.github/workflows/audit.yml' },
  ];
  async function installAuditTooling(wsId) {
    if (!isPrimary()) throw new Error(READONLY);
    const ws = await db.getWorkspace(wsId);
    if (!ws || !ws.owner || !ws.repo) throw new Error('This workspace is not connected to a repo.');
    const token = await db.getWorkspacePat(wsId);
    if (!token) throw new Error('No access token is stored for this workspace.');
    const client = makeClient(ws, token);
    const ref = await client.getRef();
    if (!ref) throw new Error('Commit the workspace first — the repository is empty.');
    const baseCommit = await client.getCommit(ref.sha);

    const files = [];
    for (const f of AUDIT_TOOLING) {
      const res = await fetch(f.src);
      if (!res.ok) throw new Error(`Could not load ${f.src} from the app.`);
      files.push({ ...f, content: await res.text() });
    }

    const push = async (list) => {
      const entries = [];
      for (const f of list)
        entries.push({ path: f.dest, mode: '100644', type: 'blob', sha: await client.createBlob({ content: f.content, encoding: 'utf-8' }) });
      const treeSha = await client.createTree({ baseTreeSha: baseCommit.treeSha, entries });
      if (treeSha === baseCommit.treeSha) return { upToDate: true };
      const commitSha = await client.createCommit({ message: 'Add PathCurator link-audit workflow', treeSha, parents: [ref.sha] });
      await client.updateRef({ sha: commitSha, force: false });
      return { commitSha };
    };

    let result;
    try { result = await push(files); }
    catch (e) {
      // Most likely the token can't write workflow files (403; message varies by token type).
      // Retry with just the scripts; if THAT also fails, the original error was something else.
      let retry;
      try { retry = await push(files.filter((f) => !f.dest.startsWith('.github/'))); }
      catch { throw e; }
      result = { ...retry, workflowSkipped: true };
    }
    // Our own commit moved the remote; advance the sync baseline so the user's next commit doesn't
    // trip the remote-ahead guard on a change we made ourselves. (Pathway files are untouched.)
    if (result.commitSha) { try { await pull(wsId, { interactive: false }); } catch { /* best-effort */ } }
    // Kick off the first audit run right away (also on update-clicks — a fresh run after upgrading
    // the checker is what you want). GitHub can lag indexing a just-committed workflow → one retry.
    // Best-effort: dispatch needs its own token permission (Actions: write); failure isn't fatal.
    if (!result.workflowSkipped) {
      result.dispatched = false;
      for (let attempt = 0; attempt < 2 && !result.dispatched; attempt++) {
        try { await client.dispatchWorkflow({ file: 'audit.yml' }); result.dispatched = true; }
        catch { if (!attempt) await new Promise((res) => setTimeout(res, 2000)); }
      }
    }
    await refreshOne(wsId);
    return { ok: true, ...result };
  }

  // Truthful tooling status for the #/audit section — probed from the repo, so it's correct across
  // devices and re-renders: is the workflow committed, are the scripts there, has a results file
  // ever been produced ("waiting on the first audit" vs "active") — and when fully installed, are
  // the committed copies CURRENT vs this app's own files (drift → the UI shows an Update button;
  // no drift → no button at all).
  async function auditToolingStatus(wsId) {
    const ws = await db.getWorkspace(wsId);
    if (!ws || !ws.owner || !ws.repo) throw new Error('This workspace is not connected to a repo.');
    const token = await db.getWorkspacePat(wsId);
    if (!token) throw new Error('No access token is stored for this workspace.');
    const client = makeClient(ws, token);
    const br = ws.branch || 'main';
    const heads = {};
    for (const f of AUDIT_TOOLING) heads[f.dest] = await client.headFile(ws.owner, ws.repo, f.dest, br);
    const results = await client.headFile(ws.owner, ws.repo, joinPath(ws.path || '', 'audit/results.json'), br);
    const workflow = heads['.github/workflows/audit.yml'].exists;
    const scripts = heads['audit/audit.mjs'].exists && heads['audit/notify.mjs'].exists;
    let current = null;                                    // null = not applicable (not fully installed)
    if (workflow && scripts) {
      current = true;
      try {
        for (const f of AUDIT_TOOLING) {
          const repoText = new TextDecoder().decode(await client.getBlobBytes(heads[f.dest].sha));
          const res = await fetch(f.src);
          if (!res.ok || repoText !== await res.text()) { current = false; break; }
        }
      } catch { current = null; }                          // comparison failed → unknown, not "drifted"
    }
    // Pertinent last-run facts for the UI, read from the committed results.json itself (best-
    // effort — a malformed file degrades to the bare "active" status, never an error): when the
    // scan ran, how many links, the issue tally, and whether THIS device has merged that sha yet.
    let lastRun = null;
    if (results.exists) {
      try {
        const rf = await client.getBlobJson(results.sha);
        const tally = { total: 0, broken: 0, auth: 0, redirected: 0, unreachable: 0 };
        for (const r of Object.values(rf?.results || {})) {
          tally.total++;
          if (r.requiresAuth) tally.auth++;
          else if (r.httpStatus == null) tally.unreachable++;
          else if (r.available === 0) tally.broken++;
          else if (r.redirectUrl) tally.redirected++;
        }
        let mergedSha = null;
        try { mergedSha = JSON.parse((await db.getSetting(`audit_state:${wsId}`)) || '{}').resultsSha ?? null; } catch { /* first run */ }
        lastRun = { generatedAt: rf?.generatedAt ?? null, ...tally, merged: mergedSha === results.sha };
      } catch { /* status stays useful without it */ }
    }
    return { ok: true, workflow, scripts, hasResults: results.exists, current, lastRun };
  }

  // P6: import the legacy curator-pathways.json into this (connected, otherwise-empty) workspace.
  // Converted pathways arrive as UNCOMMITTED local content — no sync-state change — so the next
  // commit writes the v2 per-pathway layout into the repo; the legacy file itself is never touched
  // (the old app keeps working against it). Idempotent: already-present pathway ids are skipped.
  async function importLegacy(wsId) {
    if (!isPrimary()) throw new Error(READONLY);
    const ws = await db.getWorkspace(wsId);
    if (!ws || !ws.owner || !ws.repo) throw new Error('This workspace is not connected to a repo.');
    const token = await db.getWorkspacePat(wsId);
    if (!token) throw new Error('No access token is stored for this workspace.');
    const client = makeClient(ws, token);
    const P = ws.path || '';
    const ref = await client.getRef();
    if (!ref) throw new Error('The repository is empty.');
    const tree = await client.getTree((await client.getCommit(ref.sha)).treeSha);
    const entry = (tree.tree || []).find((e) => e.type === 'blob' && e.path === joinPath(P, LEGACY_FILE));
    if (!entry) throw new Error(`No legacy ${LEGACY_FILE} in this repository.`);
    const raw = await client.getBlobJson(entry.sha);
    const { pathways, images } = await convertLegacyPathways(raw);
    if (!pathways.length) return { ok: true, total: 0, added: 0, skipped: 0, quarantined: 0 };
    const r = await db.importPathwaysIntoWorkspace({ workspaceId: wsId, pathways, images });
    await refreshOne(wsId);
    return { ok: true, total: pathways.length, ...r };
  }

  // Apply an interactively-reviewed pull. resolutions: { [pathwayId]: choice } for review items.
  async function resolvePull(wsId, resolutions = {}) {
    const context = pendingPull.get(wsId);
    if (!context) throw new Error('No pending pull to resolve.');
    const decisions = [
      ...context.plan.auto.map((i) => toDecision(i, context.remoteObjs)),
      ...context.plan.review.map((i) => {
        const action = resolutionToAction(i, resolutions[i.id]);
        if (action === 'replace' || action === 'add') return { id: i.id, action: 'replace', obj: context.remoteObjs[i.id] };
        if (action === 'delete') return { id: i.id, action: 'delete' };
        return null;
      }),
    ].filter(Boolean);
    const applied = await applyAndAdvance(wsId, context, decisions);
    pendingPull.delete(wsId);
    return applied;
  }

  // Fetch the LAST-COMMITTED version of the given pathways (from the sync baseline) — for the
  // uncommitted-changes diff. Returns { id: committedPathwayObj }.
  async function fetchCommittedPathways(wsId, ids = []) {
    const ws = await db.getWorkspace(wsId);
    if (!ws?.owner || !ws.repo) return {};
    const token = await db.getWorkspacePat(wsId);
    if (!token) throw new Error('No access token is stored for this workspace.');
    const state = await db.getSyncState(wsId);
    if (!state?.lastCommitSha) return {};
    const client = makeClient(ws, token);
    const P = ws.path || '';
    const tree = await client.getTree((await client.getCommit(state.lastCommitSha)).treeSha);
    const pathToSha = new Map();
    for (const e of tree.tree) if (e.type === 'blob') pathToSha.set(e.path, e.sha);
    const out = {};
    for (const id of ids) {
      const sha = state.files?.[id]?.blobSha || pathToSha.get(joinPath(P, `pathways/${id}.json`));
      if (!sha) continue;                        // not in the baseline → a locally-ADDED pathway
      try { out[id] = (await client.getBlobJson(sha)).pathway; } catch { /* skip unreadable */ }
    }
    return out;
  }

  // Discard uncommitted local changes: revert every dirty pathway to its LAST-COMMITTED version
  // (the sync baseline), delete locally-added-but-never-committed pathways, and restore
  // locally-deleted ones. sync_state stays at the baseline, so the workspace ends up clean. This is
  // "git checkout -- ." for the workspace; it never touches the repo.
  async function discardLocalChanges(wsId) {
    if (!isPrimary()) throw new Error(READONLY);
    const ws = await db.getWorkspace(wsId);
    if (!ws?.owner || !ws.repo) throw new Error('This workspace is not connected to a repo.');
    const token = await db.getWorkspacePat(wsId);
    if (!token) throw new Error('No access token is stored for this workspace.');
    const state = await db.getSyncState(wsId);
    if (!state?.lastCommitSha) throw new Error('This workspace has never been committed — there is no version to reset to.');
    const client = makeClient(ws, token);
    const P = ws.path || '';

    const uc = await db.getUncommittedCount(wsId);
    const commit = await client.getCommit(state.lastCommitSha);
    const tree = await client.getTree(commit.treeSha);
    const pathToSha = new Map();
    for (const e of tree.tree) if (e.type === 'blob') pathToSha.set(e.path, e.sha);
    const manifest = await client.getBlobJson(pathToSha.get(joinPath(P, 'manifest.json')));
    const remoteIndex = (manifest.pathways || []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const remoteOrder = remoteIndex.map((e) => e.id);
    const baselineIds = new Set(remoteOrder);

    const decisions = [], images = {};
    // changed/removed pathways that EXIST in the baseline → replace with the committed version
    for (const id of new Set([...uc.changedPathwayIds, ...uc.removedPathwayIds])) {
      if (!baselineIds.has(id)) continue;
      const sha = state.files?.[id]?.blobSha || pathToSha.get(joinPath(P, `pathways/${id}.json`));
      if (!sha) continue;
      const obj = await client.getBlobJson(sha);
      decisions.push({ id, action: 'replace', obj });
      const hi = obj.pathway?.header_image;
      if (hi?.sha256 && hi.file && !(await db.hasAttachmentSha(hi.sha256))) {
        const gsha = pathToSha.get(joinPath(P, hi.file));
        if (gsha) images[hi.sha256] = { bytes: await client.getBlobBytes(gsha), mime: hi.mime, ext: hi.ext };
      }
    }
    // locally-ADDED pathways (dirty, not in baseline) → delete (they were never committed)
    for (const id of uc.changedPathwayIds) if (!baselineIds.has(id)) decisions.push({ id, action: 'delete' });

    await db.applyPull({ workspaceId: wsId, decisions, remoteOrder, images,
      commitSha: state.lastCommitSha, treeSha: commit.treeSha, filesMap: state.files,
      manifestHash: state.manifestHash, workspaceHash: state.lastCommitHash });   // sync_state stays at baseline → clean
    clearConflict(wsId);
    await refreshOne(wsId);
    return { ok: true, reverted: decisions.length };
  }

  return {
    // status
    onStatusChange: (cb) => { subscribers.add(cb); return () => subscribers.delete(cb); },
    getStatus: (wsId) => statusByWs.get(wsId) || null,
    snapshot,
    totalUncommitted: () => snapshot().reduce((n, s) => n + (s.uncommittedCount || 0), 0),
    hasConflict: () => snapshot().some((s) => s.remoteAhead),
    // lifecycle
    init: () => refreshAll(),
    refreshOne, refreshAll,
    handleChange: (evt) => { if (!evt || evt.entity === '*' || ['pathways', 'steps', 'bookmarks', 'workspaces', 'sync'].includes(evt.entity)) refreshAll(); },
    commit, initialize, pull, resolvePull, importLegacy, installAuditTooling, auditToolingStatus, remoteHead,
    scormPublishInfo, setScormPublish, publishScorm,
    fetchCommittedPathways, discardLocalChanges,
    getPendingPull: (wsId) => pendingPull.get(wsId) || null,
    getAutoCommit, setAutoCommit, startTimers, stopTimers,
    // exposed for the connect flow / tests
    _computeStatus: computeStatus, _autoTick: autoTick,
  };
}
