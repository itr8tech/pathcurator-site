// PathCurator v2 — DB worker (P1). Owns the single SQLite/opfs-sahpool connection.
// sahpool sync access handles are worker-only, so ALL SQL runs here; the main thread
// talks to us over an async RPC envelope ({id, op, args} -> {id, ok, result|error}).
import sqlite3InitModule from '/vendor/index.mjs';
import { SCHEMA_SQL, SCHEMA_VERSION, TABLES, MIGRATIONS, runMigrations } from './schema.js';
import { hydratePathway, buildManifest, bytesToBase64, mimeExt, slug } from './serialize.js';
import { contentHash, versionLabel, manifestHashOf, workspaceHashOf, sha256HexBytes } from './canonical.js';

let db = null;
const ready = init();

async function init() {
  const sqlite3 = await sqlite3InitModule();
  if (!sqlite3.installOpfsSAHPoolVfs) throw new Error('this sqlite-wasm build lacks opfs-sahpool');
  // Handoff race: when a previous primary tab closes, its sync access handles may still be
  // releasing. Retry briefly so the promoted tab can acquire the pool.
  let pool, lastErr;
  for (let i = 0; i < 20; i++) {
    try { pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'pathcurator', initialCapacity: 12 }); break; }
    catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 200)); }
  }
  if (!pool) throw new Error('could not acquire opfs-sahpool (still held?): ' + (lastErr?.message || lastErr));
  db = new pool.OpfsSAHPoolDb('/pathcurator.sqlite3');
  // FK + durability PRAGMAs on the CONNECTION, outside any transaction (else FK is a silent no-op).
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec('PRAGMA synchronous=NORMAL;');
  const migration = migrate();
  return { sqliteVersion: sqlite3.version.libVersion, schemaVersion: SCHEMA_VERSION, migration };
}

// Create-or-UPGRADE. This used to be create-if-absent only: it stamped schema_version on a fresh
// database and never read it back, so the first post-launch schema change would have left every
// existing user on the old shape with new code running against it. Returns what it did so the
// caller (and tests) can see it.
function migrate() {
  const hasMeta = db.selectValue(
    "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='schema_meta'");
  if (!hasMeta) {
    db.exec(SCHEMA_SQL);
    db.exec({ sql: "INSERT INTO schema_meta (key,value) VALUES ('schema_version',?)", bind: [String(SCHEMA_VERSION)] });
    return { fresh: true, from: SCHEMA_VERSION, to: SCHEMA_VERSION, applied: [] };
  }
  const from = Number(db.selectValue("SELECT value FROM schema_meta WHERE key='schema_version'"));
  // The stepping/rollback logic lives in schema.js so it can be tested against a recording fake;
  // this is only the adapter that binds it to the real connection.
  const io = {
    exec: (sql) => db.exec(sql),
    selectObjects: (sql) => db.selectObjects(sql),
    setVersion: (v) => db.exec({ sql: "UPDATE schema_meta SET value=? WHERE key='schema_version'", bind: [String(v)] }),
  };
  return { fresh: false, ...runMigrations(io, { from, to: SCHEMA_VERSION, migrations: MIGRATIONS }) };
}

function reset() {                       // dev convenience: drop everything and re-migrate
  db.exec('PRAGMA foreign_keys=OFF;');
  for (const t of TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
  db.exec('PRAGMA foreign_keys=ON;');
  migrate();
  return { reset: true };
}

// Import one workspace's pathways (converter output shape) in a single transaction.
function importWorkspace({ workspace, orgLabel, owner = null, repo = null, branch = 'main', path = '', pathways = [] }) {
  const wsId = crypto.randomUUID();
  db.transaction(() => {
    db.exec({
      sql: `INSERT INTO workspaces (id,org_label,owner,repo,branch,path,username,colour,sort_order,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`,
      bind: [wsId, orgLabel, owner, repo, branch, path, null, null, workspaceCount(), Date.now()],
    });
    pathways.forEach((wrap, pi) => {
      const p = wrap.pathway ?? wrap;
      db.exec({
        sql: `INSERT INTO pathways
          (id,workspace_id,name,description,content_warning,acknowledgments,header_image_id,
           sort_order,created_at,last_updated,version,created_by,modified_by,extra_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        bind: [p.id, wsId, p.name, p.description ?? '', p.content_warning ?? '', p.acknowledgments ?? '',
               null, p.sort_order ?? pi, p.created_at ?? null, p.last_updated ?? null,
               p.version ?? null, p.created_by ?? null, p.modified_by ?? null,
               JSON.stringify(p.extra ?? {})],
      });
      for (const v of (p.version_history ?? [])) {
        db.exec({
          sql: `INSERT INTO version_history (pathway_id,hash,timestamp,step_count,bookmark_count,modified_by)
                VALUES (?,?,?,?,?,?)`,
          bind: [p.id, v.hash ?? '', v.timestamp ?? Date.now(), v.stepCount ?? null, v.bookmarkCount ?? null, v.modifiedBy ?? null],
        });
      }
      for (const s of (p.steps ?? [])) {
        db.exec({
          sql: `INSERT INTO steps (id,pathway_id,name,objective,pause_and_reflect,sort_order,extra_json)
                VALUES (?,?,?,?,?,?,?)`,
          bind: [s.id, p.id, s.name, s.objective ?? '', s.pause_and_reflect ?? '', s.sort_order ?? 0, null],
        });
        for (const b of (s.bookmarks ?? [])) {
          db.exec({
            sql: `INSERT INTO bookmarks
              (id,step_id,title,url,url_norm,description,context,required,content_type,added_at,sort_order,
               last_checked,available,http_status,status_label,redirect_url,check_error,requires_auth,check_method,check_duration,extra_json)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            bind: [b.id, s.id, b.title ?? '', b.url, b.url_norm ?? b.url, b.description ?? '', b.context ?? '',
                   b.required ?? 1, b.content_type ?? 'Read', b.added_at ?? null, b.sort_order ?? 0,
                   b.last_checked ?? null, b.available ?? null, b.http_status ?? null, b.status_label ?? null,
                   b.redirect_url ?? null, b.check_error ?? null, b.requires_auth ?? null,
                   b.check_method ?? null, b.check_duration ?? null, b.extra ? JSON.stringify(b.extra) : null],
          });
        }
      }
    });
  });
  return { wsId, pathways: pathways.length };
}

const workspaceCount = () => db.selectValue('SELECT count(*) FROM workspaces');

function counts() {
  return {
    workspaces: db.selectValue('SELECT count(*) FROM workspaces'),
    pathways: db.selectValue('SELECT count(*) FROM pathways'),
    steps: db.selectValue('SELECT count(*) FROM steps'),
    bookmarks: db.selectValue('SELECT count(*) FROM bookmarks'),
    versionHistory: db.selectValue('SELECT count(*) FROM version_history'),
    contentTypes: db.selectObjects('SELECT content_type, count(*) AS n FROM bookmarks GROUP BY content_type ORDER BY content_type'),
    required: db.selectObjects('SELECT required, count(*) AS n FROM bookmarks GROUP BY required ORDER BY required'),
    fkViolations: db.selectObjects('PRAGMA foreign_key_check').length,
  };
}

function getWorkspaces() {
  return db.selectObjects(`
    SELECT w.id, w.org_label, w.owner, w.repo, w.branch, w.path, w.username, w.colour, w.sort_order,
           (SELECT count(*) FROM pathways p WHERE p.workspace_id = w.id) AS pathway_count
      FROM workspaces w ORDER BY w.sort_order, w.org_label`);
}

// Pathway list for the dashboard (with step/link counts), grouped-orderable by workspace.
function listPathways() {
  return db.selectObjects(`
    SELECT p.id, p.workspace_id, w.org_label AS org, p.name, p.description, p.version, p.sort_order,
           (SELECT count(*) FROM steps s WHERE s.pathway_id=p.id) AS steps,
           (SELECT count(*) FROM bookmarks b JOIN steps s ON s.id=b.step_id WHERE s.pathway_id=p.id) AS bookmarks,
           (SELECT count(*) FROM bookmarks b JOIN steps s ON s.id=b.step_id WHERE s.pathway_id=p.id AND b.available=0) AS broken
      FROM pathways p JOIN workspaces w ON w.id=p.workspace_id
     ORDER BY w.sort_order, w.org_label, p.sort_order`);
}

// Deep read for the pathway detail view: pathway + its steps + each step's bookmarks.
function getPathwayDeep(id) {
  const p = db.selectObject(
    `SELECT p.*, w.org_label AS org FROM pathways p LEFT JOIN workspaces w ON w.id=p.workspace_id WHERE p.id=?`, [id]);
  if (!p) return null;
  p.steps = db.selectObjects(`SELECT * FROM steps WHERE pathway_id=? ORDER BY sort_order`, [id]);
  for (const s of p.steps)
    s.bookmarks = db.selectObjects(`SELECT * FROM bookmarks WHERE step_id=? ORDER BY sort_order`, [s.id]);
  p.versionHistory = db.selectObjects(
    `SELECT hash, timestamp, step_count, bookmark_count, modified_by FROM version_history
      WHERE pathway_id=? ORDER BY timestamp DESC LIMIT 10`, [id]);
  return p;
}

// ===== P2 write helpers =====
const ORDER_CFG = {
  pathway:  { table: 'pathways',  parentCol: 'workspace_id' },
  step:     { table: 'steps',     parentCol: 'pathway_id' },
  bookmark: { table: 'bookmarks', parentCol: 'step_id' },
};
const CONTENT_TYPES = new Set(['Read', 'Watch', 'Listen', 'Participate']);
const PARK = 1000000; // temp sort_order for a reparented row; larger than any sibling count

const currentActor = () => db.selectValue("SELECT value FROM settings WHERE key='display_name'") ?? null;

function assertContentType(ct) {
  if (!CONTENT_TYPES.has(ct)) throw new Error('Invalid content type: ' + ct);
  return ct;
}
// bookmark.url becomes a real <a href> on the PAT-holding origin → reject dangerous schemes at SAVE time.
function assertSafeUrl(url) {
  const s = String(url ?? '').trim();
  if (!s) throw new Error('URL is required.');
  if (/^\s*(javascript|data|vbscript|blob|file):/i.test(s)) throw new Error('Unsupported URL scheme.');
  if (!/^(https?|mailto|tel):/i.test(s)) throw new Error('URL must start with http://, https://, mailto: or tel:');
  return s;
}
function normalizeUrl(raw) {
  const s = String(raw).trim();
  try {
    const u = new URL(s);
    u.hash = ''; u.hostname = u.hostname.toLowerCase();
    let out = u.toString();
    if (u.pathname !== '/' && out.endsWith('/')) out = out.slice(0, -1);
    return out;
  } catch { return s.toLowerCase(); }
}

const nextOrder = (table, col, parentId) =>
  db.selectValue(`SELECT COALESCE(MAX(sort_order),-1)+1 FROM ${table} WHERE ${col} IS ?`, [parentId]);
const siblingIds = (cfg, parentId) =>
  db.selectObjects(`SELECT id FROM ${cfg.table} WHERE ${cfg.parentCol} IS ? ORDER BY sort_order`, [parentId]).map((r) => r.id);
const pathwayIdOfStep = (id) => db.selectValue('SELECT pathway_id FROM steps WHERE id=?', [id]);
const pathwayIdOfBookmark = (id) =>
  db.selectValue('SELECT s.pathway_id FROM bookmarks b JOIN steps s ON s.id=b.step_id WHERE b.id=?', [id]);
const touchPathway = (id) => {
  if (id) db.exec({ sql: 'UPDATE pathways SET last_updated=?, modified_by=COALESCE(?,modified_by) WHERE id=?',
                    bind: [Date.now(), currentActor(), id] });
};

// UNIQUE(parent,sort_order)-safe renumber of an ALREADY-ORDERED id list (park to negatives, then compact 0..n-1).
function renumber(table, orderedIds) {
  orderedIds.forEach((rid, i) => db.exec({ sql: `UPDATE ${table} SET sort_order=? WHERE id=?`, bind: [-(i + 1), rid] }));
  orderedIds.forEach((rid, i) => db.exec({ sql: `UPDATE ${table} SET sort_order=? WHERE id=?`, bind: [i, rid] }));
}

// ===== PATHWAY =====
function createPathway({ workspace_id = null, name, description = '', content_warning = '', acknowledgments = '' }) {
  const nm = String(name || '').trim();
  if (!nm) throw new Error('Pathway name is required.');
  const id = crypto.randomUUID();
  const now = Date.now(), actor = currentActor();
  db.transaction(() => db.exec({
    sql: `INSERT INTO pathways
      (id,workspace_id,name,description,content_warning,acknowledgments,header_image_id,
       sort_order,created_at,last_updated,version,created_by,modified_by,extra_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    bind: [id, workspace_id, nm, description, content_warning, acknowledgments, null,
           nextOrder('pathways', 'workspace_id', workspace_id), now, now, null, actor, actor, null],
  }));
  return { id };
}
function updatePathway({ id, name, description = '', content_warning = '', acknowledgments = '' }) {
  const nm = String(name || '').trim();
  if (!nm) throw new Error('Pathway name is required.');
  db.exec({ sql: `UPDATE pathways SET name=?, description=?, content_warning=?, acknowledgments=?,
                  last_updated=?, modified_by=COALESCE(?,modified_by) WHERE id=?`,
    bind: [nm, description, content_warning, acknowledgments, Date.now(), currentActor(), id] });
  return { id };
}
function deletePathway({ id }) {
  db.transaction(() => {
    const ws = db.selectValue('SELECT workspace_id FROM pathways WHERE id=?', [id]);
    db.exec({ sql: 'DELETE FROM pathways WHERE id=?', bind: [id] });
    renumber('pathways', siblingIds(ORDER_CFG.pathway, ws));
  });
  return { id };
}

// ===== STEP =====
function createStep({ pathway_id, name, objective = '', pause_and_reflect = '' }) {
  if (!pathway_id) throw new Error('Missing pathway.');
  const nm = String(name || '').trim();
  if (!nm) throw new Error('Step name is required.');
  const id = crypto.randomUUID();
  db.transaction(() => {
    db.exec({ sql: `INSERT INTO steps (id,pathway_id,name,objective,pause_and_reflect,sort_order,extra_json)
                    VALUES (?,?,?,?,?,?,?)`,
      bind: [id, pathway_id, nm, objective, pause_and_reflect, nextOrder('steps', 'pathway_id', pathway_id), null] });
    touchPathway(pathway_id);
  });
  return { id };
}
function updateStep({ id, name, objective = '', pause_and_reflect = '' }) {
  const nm = String(name || '').trim();
  if (!nm) throw new Error('Step name is required.');
  db.transaction(() => {
    db.exec({ sql: `UPDATE steps SET name=?, objective=?, pause_and_reflect=? WHERE id=?`,
      bind: [nm, objective, pause_and_reflect, id] });
    touchPathway(pathwayIdOfStep(id));
  });
  return { id };
}
function deleteStep({ id }) {
  db.transaction(() => {
    const pid = pathwayIdOfStep(id);
    db.exec({ sql: 'DELETE FROM steps WHERE id=?', bind: [id] });
    renumber('steps', siblingIds(ORDER_CFG.step, pid));
    touchPathway(pid);
  });
  return { id };
}

// ===== BOOKMARK =====
function createBookmark({ step_id, title = '', url, description = '', context = '', required = 1, content_type = 'Read' }) {
  if (!step_id) throw new Error('Missing step.');
  const safe = assertSafeUrl(url); assertContentType(content_type);
  const id = crypto.randomUUID();
  db.transaction(() => {
    db.exec({ sql: `INSERT INTO bookmarks
      (id,step_id,title,url,url_norm,description,context,required,content_type,added_at,sort_order,extra_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      bind: [id, step_id, String(title).trim(), safe, normalizeUrl(safe), description, context,
             required ? 1 : 0, content_type, Date.now(), nextOrder('bookmarks', 'step_id', step_id), null] });
    touchPathway(pathwayIdOfStep(step_id));
  });
  return { id };
}
function updateBookmark({ id, title = '', url, description = '', context = '', required = 1, content_type = 'Read' }) {
  const safe = assertSafeUrl(url); assertContentType(content_type);
  db.transaction(() => {
    db.exec({ sql: `UPDATE bookmarks SET title=?, url=?, url_norm=?, description=?, context=?, required=?, content_type=? WHERE id=?`,
      bind: [String(title).trim(), safe, normalizeUrl(safe), description, context, required ? 1 : 0, content_type, id] });
    touchPathway(pathwayIdOfBookmark(id));
  });
  return { id };
}
function deleteBookmark({ id }) {
  db.transaction(() => {
    const step = db.selectValue('SELECT step_id FROM bookmarks WHERE id=?', [id]);
    const pid  = pathwayIdOfStep(step);
    db.exec({ sql: 'DELETE FROM bookmarks WHERE id=?', bind: [id] });
    renumber('bookmarks', siblingIds(ORDER_CFG.bookmark, step));
    touchPathway(pid);
  });
  return { id };
}

// ===== HEADER IMAGE (attachments) =====
function setHeaderImage({ pathwayId, mime, bytes, byte_len, sha256 = null }) {
  if (!pathwayId) throw new Error('Missing pathway.');
  if (!bytes) throw new Error('Missing image data.');
  const id = crypto.randomUUID();
  db.transaction(() => {
    const prev = db.selectValue('SELECT header_image_id FROM pathways WHERE id=?', [pathwayId]);
    db.exec({ sql: 'INSERT INTO attachments (id,mime,bytes,byte_len,sha256,created_at) VALUES (?,?,?,?,?,?)',
      bind: [id, mime || 'application/octet-stream', bytes, byte_len ?? bytes.byteLength ?? bytes.length ?? 0, sha256, Date.now()] });
    db.exec({ sql: 'UPDATE pathways SET header_image_id=? WHERE id=?', bind: [id, pathwayId] });
    if (prev) db.exec({ sql: 'DELETE FROM attachments WHERE id=?', bind: [prev] });   // drop the orphan
    touchPathway(pathwayId);
  });
  return { attachmentId: id };
}
function removeHeaderImage({ pathwayId }) {
  db.transaction(() => {
    const prev = db.selectValue('SELECT header_image_id FROM pathways WHERE id=?', [pathwayId]);
    db.exec({ sql: 'UPDATE pathways SET header_image_id=NULL WHERE id=?', bind: [pathwayId] });
    if (prev) db.exec({ sql: 'DELETE FROM attachments WHERE id=?', bind: [prev] });
    touchPathway(pathwayId);
  });
  return { pathwayId };
}

// ===== WORKSPACE (rename / delete) =====
function renameWorkspace({ id, org_label }) {
  const nm = String(org_label || '').trim();
  if (!nm) throw new Error('Workspace name is required.');
  db.exec({ sql: 'UPDATE workspaces SET org_label=? WHERE id=?', bind: [nm, id] });
  return { id };
}
// Deleting a workspace removes it AND its pathways (cascades steps→bookmarks→history), then
// renumbers remaining workspaces, clears its per-workspace sync settings, and GCs orphaned
// attachments. The PAT (PathCuratorSecrets, main thread) is dropped by the db.js facade wrapper.
function deleteWorkspace({ id }) {
  db.transaction(() => {
    db.exec({ sql: 'DELETE FROM pathways WHERE workspace_id=?', bind: [id] });
    db.exec({ sql: 'DELETE FROM workspaces WHERE id=?', bind: [id] });
    db.exec({ sql: "DELETE FROM settings WHERE key IN ('sync_state:'||?, 'auto_commit:'||?)", bind: [id, id] });
    renumber('workspaces', db.selectObjects('SELECT id FROM workspaces ORDER BY sort_order').map((r) => r.id));
    db.exec(`DELETE FROM attachments WHERE id NOT IN (
      SELECT header_image_id FROM pathways WHERE header_image_id IS NOT NULL
      UNION SELECT image_blob_id FROM inbox WHERE image_blob_id IS NOT NULL)`);
  });
  return { id };
}

// ===== moveEntity (pointer + keyboard, DB-authoritative) =====
function moveEntity({ entity, id, toParentId = null, toIndex = 0 }) {
  const cfg = ORDER_CFG[entity];
  if (!cfg) throw new Error('Unknown entity: ' + entity);
  db.transaction(() => {
    const row = db.selectObject(`SELECT ${cfg.parentCol} AS parent FROM ${cfg.table} WHERE id=?`, [id]);
    if (!row) throw new Error('Item not found.');
    const fromParent = row.parent;
    const toParent = toParentId ?? fromParent;

    if (toParent !== fromParent) {
      if (entity !== 'bookmark') throw new Error('Only bookmarks can move between parents.');
      db.exec({ sql: `UPDATE ${cfg.table} SET ${cfg.parentCol}=?, sort_order=? WHERE id=?`, bind: [toParent, PARK, id] });
    }

    if (entity === 'bookmark') {
      // Bookmarks are GROUPED required-first (in the app UI and the published page), so a move
      // happens WITHIN the mover's group: toIndex is its position among same-required siblings.
      // Rebuilding as [required…, bonus…] also self-heals interleaved legacy/imported ordering
      // the first time anything in the step is moved.
      const req = db.selectValue('SELECT required FROM bookmarks WHERE id=?', [id]);
      const rows = db.selectObjects(
        'SELECT id, required FROM bookmarks WHERE step_id=? AND id IS NOT ? ORDER BY sort_order', [toParent, id]);
      const same = rows.filter((r) => r.required === req).map((r) => r.id);
      const other = rows.filter((r) => r.required !== req).map((r) => r.id);
      const idx = Math.max(0, Math.min(Number(toIndex) || 0, same.length));
      same.splice(idx, 0, id);
      renumber(cfg.table, req ? [...same, ...other] : [...other, ...same]);
    } else {
      const dest = siblingIds(cfg, toParent).filter((x) => x !== id);
      const idx = Math.max(0, Math.min(Number(toIndex) || 0, dest.length));
      dest.splice(idx, 0, id);
      renumber(cfg.table, dest);
    }
    if (toParent !== fromParent) renumber(cfg.table, siblingIds(cfg, fromParent));

    if (entity === 'step') touchPathway(fromParent);
    if (entity === 'bookmark') {
      touchPathway(pathwayIdOfStep(fromParent));
      if (toParent !== fromParent) touchPathway(pathwayIdOfStep(toParent));
    }
  });
  return { id };
}

// ===== P3: workspace lifecycle (connect / repo config) =====
// createWorkspace accepts a CALLER-GENERATED id so the facade can store the PAT (keyed by that
// id) before the row exists. The PAT never reaches the worker.
function createWorkspace({ id, org_label, owner = null, repo = null, branch = 'main', path = '', username = null, colour = null }) {
  const nm = String(org_label || '').trim();
  if (!nm) throw new Error('Workspace name is required.');
  const wsId = id || crypto.randomUUID();
  db.exec({
    sql: `INSERT INTO workspaces (id,org_label,owner,repo,branch,path,username,colour,sort_order,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    bind: [wsId, nm, owner, repo, branch || 'main', path || '', username, colour, workspaceCount(), Date.now()],
  });
  return { id: wsId };
}
const getWorkspaceFull = (id) =>
  db.selectObject(`SELECT id,org_label,owner,repo,branch,path,username,colour,sort_order,created_at
                     FROM workspaces WHERE id=?`, [id]);

function setWorkspaceRepo({ id, owner = null, repo = null, branch = 'main', path = '', username = null, org_label = null, colour = null }) {
  const cur = db.selectObject('SELECT owner,repo,branch,path FROM workspaces WHERE id=?', [id]);
  if (!cur) throw new Error('Workspace not found.');
  const repoChanged = owner !== cur.owner || repo !== cur.repo || (branch || 'main') !== cur.branch || (path || '') !== cur.path;
  db.transaction(() => {
    db.exec({
      sql: `UPDATE workspaces SET owner=?, repo=?, branch=?, path=?,
              username=COALESCE(?,username), org_label=COALESCE(?,org_label), colour=COALESCE(?,colour) WHERE id=?`,
      bind: [owner, repo, branch || 'main', path || '', username, org_label ? String(org_label).trim() : null, colour, id],
    });
    // Repointing at a different repo/branch/path invalidates the old sync baseline.
    if (repoChanged) db.exec({ sql: "DELETE FROM settings WHERE key IN ('sync_state:'||?, 'auto_commit:'||?)", bind: [id, id] });
  });
  return { id, repoChanged };
}
const setWorkspaceRepoMeta = ({ id, username }) => {
  db.exec({ sql: 'UPDATE workspaces SET username=COALESCE(?,username) WHERE id=?', bind: [username ?? null, id] });
  return { id };
};

// ===== P3: sync state (per-workspace settings row) =====
function syncStateObj(workspaceId) {
  const raw = db.selectValue('SELECT value FROM settings WHERE key=?', [`sync_state:${workspaceId}`]);
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}
const getSyncState = (workspaceId) => { const s = syncStateObj(workspaceId); return Object.keys(s).length ? s : null; };
function setSyncState({ workspaceId, state }) {
  db.exec({ sql: `INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    bind: [`sync_state:${workspaceId}`, JSON.stringify(state || {})] });
  return { workspaceId };
}

// Resolve a header-image attachment → { sha256, mime, ext, bytes }. Computes + PERSISTS sha256
// when the attachment row lacks one (app-uploaded images may store null).
async function resolveHeaderImage(attId) {
  if (!attId) return null;
  const a = db.selectObject('SELECT id,mime,bytes,byte_len,sha256 FROM attachments WHERE id=?', [attId]);
  if (!a) return null;
  let sha = a.sha256;
  if (!sha) {
    sha = await sha256HexBytes(a.bytes instanceof Uint8Array ? a.bytes : new Uint8Array(a.bytes));
    db.exec({ sql: 'UPDATE attachments SET sha256=? WHERE id=?', bind: [sha, attId] });
  }
  return { sha256: sha, mime: a.mime, ext: mimeExt(a.mime), bytes: a.bytes };
}

// Shared core: gather the workspace graph, hydrate + hash every pathway, diff vs the sync baseline.
// withPayload=true additionally builds the committed file bytes + image blobs + version stamps.
async function buildWorkspaceState(workspaceId, { withPayload = false, modifiedBy = null, dateIso = null } = {}) {
  const ws = db.selectObject('SELECT * FROM workspaces WHERE id=?', [workspaceId]);
  if (!ws) throw new Error('Workspace not found.');
  const base = syncStateObj(workspaceId);
  const baseFiles = base.files || {};              // { id: { contentHash, blobSha } }
  const author = ws.username || modifiedBy || '';

  const rows = db.selectObjects('SELECT * FROM pathways WHERE workspace_id=? ORDER BY sort_order', [workspaceId]);
  const index = [];
  const pathwayHashes = {};
  const hydrated = {};
  let stepTotal = 0, bmTotal = 0;

  for (const p of rows) {
    const steps = db.selectObjects('SELECT * FROM steps WHERE pathway_id=? ORDER BY sort_order', [p.id]);
    for (const s of steps) s.bookmarks = db.selectObjects('SELECT * FROM bookmarks WHERE step_id=? ORDER BY sort_order', [s.id]);
    const vh = db.selectObjects(
      `SELECT hash,timestamp,step_count,bookmark_count,modified_by FROM version_history
         WHERE pathway_id=? ORDER BY timestamp DESC LIMIT 10`, [p.id]);
    const headerImage = await resolveHeaderImage(p.header_image_id);
    const obj = hydratePathway({ pathway: p, steps, versionHistory: vh, headerImage });
    const ch = await contentHash(obj.pathway);       // excludes version/version_history/timestamps/audit
    pathwayHashes[p.id] = ch;
    hydrated[p.id] = { obj, ch, headerImage, steps };
    index.push({ id: p.id, file: `pathways/${p.id}.json`, sort_order: p.sort_order, name: p.name });
    stepTotal += steps.length;
    for (const s of steps) bmTotal += s.bookmarks.length;
  }

  const counts = { pathways: rows.length, steps: stepTotal, bookmarks: bmTotal };
  const manifestHash = await manifestHashOf(index);
  const workspaceHash = await workspaceHashOf(manifestHash, pathwayHashes);
  const manifestChanged = manifestHash !== base.manifestHash;

  const changedPathwayIds = rows.map((p) => p.id).filter((id) => baseFiles[id]?.contentHash !== pathwayHashes[id]);
  const removedPathwayIds = Object.keys(baseFiles).filter((id) => !(id in pathwayHashes));

  const summary = {
    workspacePath: ws.path || '',
    manifestHash, workspaceHash, manifestChanged,
    baseCommitSha: base.lastCommitSha || null,
    changedPathwayIds, removedPathwayIds,
    changedCount: changedPathwayIds.length, deletedCount: removedPathwayIds.length,
    pathwayHashes, counts,
  };
  if (!withPayload) return summary;

  const now = dateIso ? new Date(dateIso) : new Date();
  const stampMs = now.getTime();
  const files = [], images = [];
  for (const id of changedPathwayIds) {
    const { obj, ch, headerImage, steps } = hydrated[id];
    const version = versionLabel(ch, now);
    const stepCount = steps.length;
    const bookmarkCount = steps.reduce((n, s) => n + s.bookmarks.length, 0);
    obj.pathway.version = version;                   // stamp published version into the file
    obj.pathway.modified_by = author || obj.pathway.modified_by;
    obj.pathway.version_history = [
      { hash: version, timestamp: stampMs, stepCount, bookmarkCount, modifiedBy: author },
      ...obj.pathway.version_history,
    ].slice(0, 10);
    files.push({
      pathwayId: id, path: `pathways/${id}.json`, content: JSON.stringify(obj, null, 2) + '\n',
      contentHash: ch, version, timestamp: stampMs, stepCount, bookmarkCount, modifiedBy: author,
    });
    if (headerImage) images.push({ path: `images/${headerImage.sha256}.${headerImage.ext}`, bytesBase64: bytesToBase64(headerImage.bytes), sha256: headerImage.sha256 });
  }
  const manifest = buildManifest({ workspace: slug(ws.org_label), orgLabel: ws.org_label, index, counts, updatedAt: stampMs });
  const deletions = removedPathwayIds.map((id) => `pathways/${id}.json`);
  const pathwayVersions = files.map((f) => ({
    id: f.pathwayId, version: f.version, contentHash: f.contentHash,
    timestamp: f.timestamp, stepCount: f.stepCount, bookmarkCount: f.bookmarkCount, modifiedBy: f.modifiedBy,
  }));
  return { ...summary, manifest, manifestBytes: JSON.stringify(manifest, null, 2) + '\n', files, images, deletions, pathwayVersions };
}

const serializeWorkspace = ({ workspaceId, modifiedBy = null, dateIso = null }) =>
  buildWorkspaceState(workspaceId, { withPayload: true, modifiedBy, dateIso });

async function getUncommittedCount({ workspaceId }) {
  const s = await buildWorkspaceState(workspaceId, { withPayload: false });
  let total = s.changedCount + s.deletedCount;
  if (total === 0 && s.manifestChanged) total = 1;   // pure reorder/rename-only still counts as 1
  return {
    changed: s.changedCount, deleted: s.deletedCount, manifestChanged: s.manifestChanged,
    total, workspaceHash: s.workspaceHash, changedPathwayIds: s.changedPathwayIds, removedPathwayIds: s.removedPathwayIds,
  };
}

// Single pathway → committed file object + its content hash (for pull/merge comparison).
async function serializePathway(id) {
  const p = db.selectObject('SELECT * FROM pathways WHERE id=?', [id]);
  if (!p) return null;
  const steps = db.selectObjects('SELECT * FROM steps WHERE pathway_id=? ORDER BY sort_order', [id]);
  for (const s of steps) s.bookmarks = db.selectObjects('SELECT * FROM bookmarks WHERE step_id=? ORDER BY sort_order', [s.id]);
  const vh = db.selectObjects(
    `SELECT hash,timestamp,step_count,bookmark_count,modified_by FROM version_history
       WHERE pathway_id=? ORDER BY timestamp DESC LIMIT 10`, [id]);
  const headerImage = await resolveHeaderImage(p.header_image_id);
  const obj = hydratePathway({ pathway: p, steps, versionHistory: vh, headerImage });
  return { obj, contentHash: await contentHash(obj.pathway) };
}

// Persist the outcome of a successful push: stamp version + version_history for changed pathways,
// then upsert sync_state. Called by the orchestrator ONLY after the remote ref advanced.
function markCommitted({ workspaceId, commitSha, treeSha = null, committedAt = null, pathwayVersions = [], manifestHash = null, workspaceHash = null, files = {} }) {
  const at = committedAt ?? Date.now();
  db.transaction(() => {
    for (const pv of pathwayVersions) {
      db.exec({ sql: 'UPDATE pathways SET version=?, modified_by=COALESCE(?,modified_by) WHERE id=?',
        bind: [pv.version, pv.modifiedBy || null, pv.id] });   // NOT last_updated (that is the LWW merge key)
      db.exec({ sql: `INSERT INTO version_history (pathway_id,hash,timestamp,step_count,bookmark_count,modified_by)
                      VALUES (?,?,?,?,?,?)`,
        bind: [pv.id, pv.version, pv.timestamp ?? at, pv.stepCount ?? null, pv.bookmarkCount ?? null, pv.modifiedBy ?? null] });
    }
    const prev = syncStateObj(workspaceId);
    const state = {
      schemaVersion: 1,
      lastCommitSha: commitSha, lastTreeSha: treeSha,
      lastCommitHash: workspaceHash, manifestHash,
      lastSyncedAt: at, files: files || {},
      connectedAt: prev.connectedAt ?? at,
    };
    db.exec({ sql: `INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      bind: [`sync_state:${workspaceId}`, JSON.stringify(state)] });
  });
  return { workspaceId, commitSha };
}

// ===== P3: pull / stable-id merge apply =====
const getLocalHashes = async ({ workspaceId }) => (await buildWorkspaceState(workspaceId, { withPayload: false })).pathwayHashes;
const hasAttachmentSha = (sha) => !!db.selectValue('SELECT 1 FROM attachments WHERE sha256=?', [sha]);

// Relink a pulled pathway's header image, deduped by content sha256: reuse an existing attachment
// with the same bytes, else insert the blob the pull fetched (images: { sha256: { bytes, mime, ext } }).
// Absent header_image, or bytes we didn't fetch (already-local case is caught by the reuse lookup),
// → NULL. Attachments orphaned by a swapped/removed image are swept at the end of applyPull.
function relinkHeaderImage(p, images) {
  const hi = p.header_image;
  if (!hi?.sha256) return null;
  const existing = db.selectValue('SELECT id FROM attachments WHERE sha256=?', [hi.sha256]);
  if (existing) return existing;
  const img = images[hi.sha256];
  if (!img?.bytes) return null;
  const bytes = img.bytes instanceof Uint8Array ? img.bytes : new Uint8Array(img.bytes);
  const id = crypto.randomUUID();
  db.exec({ sql: 'INSERT INTO attachments (id,mime,bytes,byte_len,sha256,created_at) VALUES (?,?,?,?,?,?)',
    bind: [id, hi.mime || img.mime || 'application/octet-stream', bytes, bytes.byteLength, hi.sha256, Date.now()] });
  return id;
}

// Upsert a pathway from a committed-file object (id-stable). Rebuilds its step subtree +
// version_history. Every imported bookmark URL passes assertSafeUrl — a compromised shared repo
// could ship url:"javascript:…" that the detail view renders as a live href. Unsafe URLs are
// SKIPPED (quarantined) and counted, not inserted. Returns the quarantined count.
function materializePathway(wsId, wrap, order, images = {}) {
  const p = wrap.pathway ?? wrap;
  const headerImageId = relinkHeaderImage(p, images);
  const existed = db.selectValue('SELECT 1 FROM pathways WHERE id=?', [p.id]);
  if (existed) {
    db.exec({ sql: 'DELETE FROM steps WHERE pathway_id=?', bind: [p.id] });          // cascades bookmarks
    db.exec({ sql: 'DELETE FROM version_history WHERE pathway_id=?', bind: [p.id] });
    db.exec({ sql: `UPDATE pathways SET workspace_id=?, name=?, description=?, content_warning=?, acknowledgments=?,
                    header_image_id=?, sort_order=?, created_at=?, last_updated=?, version=?, created_by=?, modified_by=?, extra_json=? WHERE id=?`,
      bind: [wsId, p.name, p.description ?? '', p.content_warning ?? '', p.acknowledgments ?? '', headerImageId, order,
             p.created_at ?? null, p.last_updated ?? null, p.version ?? null, p.created_by ?? null, p.modified_by ?? null,
             JSON.stringify(p.extra ?? {}), p.id] });
  } else {
    db.exec({ sql: `INSERT INTO pathways (id,workspace_id,name,description,content_warning,acknowledgments,header_image_id,
                    sort_order,created_at,last_updated,version,created_by,modified_by,extra_json)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      bind: [p.id, wsId, p.name, p.description ?? '', p.content_warning ?? '', p.acknowledgments ?? '', headerImageId, order,
             p.created_at ?? null, p.last_updated ?? null, p.version ?? null, p.created_by ?? null, p.modified_by ?? null,
             JSON.stringify(p.extra ?? {})] });
  }
  for (const v of (p.version_history ?? []))
    db.exec({ sql: `INSERT INTO version_history (pathway_id,hash,timestamp,step_count,bookmark_count,modified_by) VALUES (?,?,?,?,?,?)`,
      bind: [p.id, v.hash ?? '', v.timestamp ?? Date.now(), v.stepCount ?? null, v.bookmarkCount ?? null, v.modifiedBy ?? null] });

  let quarantined = 0;
  (p.steps ?? []).forEach((s, si) => {
    db.exec({ sql: `INSERT INTO steps (id,pathway_id,name,objective,pause_and_reflect,sort_order,extra_json) VALUES (?,?,?,?,?,?,?)`,
      bind: [s.id, p.id, s.name, s.objective ?? '', s.pause_and_reflect ?? '', s.sort_order ?? si, null] });
    (s.bookmarks ?? []).forEach((b, bi) => {
      let safe;
      try { safe = assertSafeUrl(b.url); assertContentType(b.content_type ?? 'Read'); }
      catch { quarantined++; return; }                                                // skip unsafe/invalid
      db.exec({ sql: `INSERT INTO bookmarks (id,step_id,title,url,url_norm,description,context,required,content_type,added_at,sort_order,extra_json)
                      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        bind: [b.id, s.id, String(b.title ?? '').trim(), safe, b.url_norm ?? normalizeUrl(safe), b.description ?? '', b.context ?? '',
               b.required ? 1 : 0, b.content_type ?? 'Read', b.added_at ?? null, b.sort_order ?? bi, null] });
    });
  });
  return quarantined;
}

// P6: import pathway objects (converted legacy, or a file-exchange import) into local content.
// sync_state is NOT touched — everything arrives UNCOMMITTED. Existing pathway ids are SKIPPED
// unless listed in `replace` (the user explicitly chose "Take import"), and a replace happens
// IN PLACE: same workspace, same sort_order slot — an import never moves a pathway between
// workspaces (that would silently delete it from one repo and add it to another on commit).
// Images are UNTRUSTED: each entry's sha256 is RECOMPUTED and must match its claimed key; wrong
// hash / disallowed mime / >5MB → dropped (protects content-addressed dedup + the repo image
// store). Added pathways park at high sort_order then every touched workspace is renumbered;
// orphaned header-image attachments are GC'd (mirrors applyPull).
const IMPORT_IMG_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
async function importPathwaysIntoWorkspace({ workspaceId, pathways = [], images = {}, replace = [] }) {
  if (!db.selectValue('SELECT 1 FROM workspaces WHERE id=?', [workspaceId])) throw new Error('Workspace not found.');
  const verified = {};
  for (const [sha, img] of Object.entries(images || {})) {          // async → resolved before the transaction
    const bytes = img?.bytes instanceof Uint8Array ? img.bytes : img?.bytes ? new Uint8Array(img.bytes) : null;
    if (!bytes || !bytes.byteLength || bytes.byteLength > 5 * 1024 * 1024) continue;
    if (!IMPORT_IMG_MIME.has(img.mime)) continue;
    if ((await sha256HexBytes(bytes)) !== sha) continue;            // the claimed hash must be TRUE
    verified[sha] = { bytes, mime: img.mime, ext: img.ext };
  }
  const allow = new Set((replace || []).map(String));
  let added = 0, replaced = 0, skipped = 0, quarantined = 0;
  db.transaction(() => {
    let park = PARK;
    const touched = new Set([workspaceId]);
    for (const wrap of pathways) {
      const p = wrap?.pathway ?? wrap;
      if (!p?.id || !p?.name) { skipped++; continue; }
      const existing = db.selectObject('SELECT workspace_id, sort_order FROM pathways WHERE id=?', [String(p.id)]);
      // A malformed/hand-edited file can reuse step/bookmark ids that belong to a DIFFERENT
      // pathway — that would PK-abort the whole transaction. Skip just that pathway instead.
      const collides = (p.steps ?? []).some((s) =>
        db.selectValue('SELECT 1 FROM steps WHERE id=? AND pathway_id IS NOT ?', [String(s.id), String(p.id)]) ||
        (s.bookmarks ?? []).some((b) => db.selectValue(
          'SELECT 1 FROM bookmarks WHERE id=? AND step_id NOT IN (SELECT id FROM steps WHERE pathway_id=?)',
          [String(b.id), String(p.id)])));
      if (collides) { skipped++; continue; }
      if (existing) {
        if (!allow.has(String(p.id))) { skipped++; continue; }
        quarantined += materializePathway(existing.workspace_id, wrap, existing.sort_order, verified);
        touched.add(existing.workspace_id);
        replaced++;
      } else {
        quarantined += materializePathway(workspaceId, wrap, park++, verified);
        added++;
      }
    }
    for (const ws of touched)
      renumber('pathways', db.selectObjects('SELECT id FROM pathways WHERE workspace_id=? ORDER BY sort_order', [ws]).map((r) => r.id));
    if (added || replaced) {
      db.exec(`DELETE FROM attachments WHERE id NOT IN (
        SELECT header_image_id FROM pathways WHERE header_image_id IS NOT NULL
        UNION SELECT image_blob_id FROM inbox WHERE image_blob_id IS NOT NULL)`);
    }
  });
  return { added, replaced, skipped, quarantined };
}

// ---- P6: file-exchange exports. One canonical shape everywhere: serializePathway per pathway
// (NOT serializeWorkspace — that stamps synthetic versions for commits) + the referenced
// header-image bytes so the file is self-contained. Read-shaped; never tokens or sync state.
async function exportPathwayData({ id }) {
  const ser = await serializePathway(id);
  if (!ser) throw new Error('Pathway not found.');
  const images = {};
  const hi = ser.obj.pathway.header_image;
  if (hi?.sha256) {
    const a = db.selectObject('SELECT bytes, mime, sha256 FROM attachments WHERE sha256=?', [hi.sha256]);
    if (a) images[a.sha256] = { bytes: a.bytes instanceof Uint8Array ? a.bytes : new Uint8Array(a.bytes), mime: a.mime, ext: hi.ext || 'jpg' };
  }
  return { obj: ser.obj, contentHash: ser.contentHash, images };
}
async function exportWorkspaceData({ workspaceId }) {
  const ws = db.selectObject('SELECT id, org_label, colour, owner, repo, branch, path FROM workspaces WHERE id=?', [workspaceId]);
  if (!ws) throw new Error('Workspace not found.');
  const pathways = [], images = {};
  for (const r of db.selectObjects('SELECT id FROM pathways WHERE workspace_id=? ORDER BY sort_order', [workspaceId])) {
    const one = await exportPathwayData({ id: r.id });
    pathways.push(one.obj);
    Object.assign(images, one.images);
  }
  return { workspace: ws, pathways, images, overrides: serializeAuditOverrides({ workspaceId }).overrides };
}
async function exportBackupData() {
  const workspaces = [], images = {};
  for (const w of db.selectObjects('SELECT id FROM workspaces ORDER BY org_label')) {
    const d = await exportWorkspaceData({ workspaceId: w.id });
    workspaces.push({ workspace: d.workspace, pathways: d.pathways, overrides: d.overrides });
    Object.assign(images, d.images);
  }
  return { workspaces, images, exempt: serializeExemptDomains().exempt };
}

// Apply a resolved pull, transactionally + idempotently, then advance the sync baseline.
function applyPull({ workspaceId, decisions = [], remoteOrder = [], images = {}, commitSha = null, treeSha = null, filesMap = null, workspaceHash = null, manifestHash = null }) {
  let added = 0, replaced = 0, deleted = 0, quarantined = 0, park = PARK;
  db.transaction(() => {
    for (const d of decisions) {
      if (d.action === 'delete') {
        if (db.selectValue('SELECT 1 FROM pathways WHERE id=? AND workspace_id=?', [d.id, workspaceId])) {
          db.exec({ sql: 'DELETE FROM pathways WHERE id=? AND workspace_id=?', bind: [d.id, workspaceId] });
          deleted++;
        }
      } else if (d.action === 'add' || d.action === 'replace') {
        const existed = db.selectValue('SELECT 1 FROM pathways WHERE id=?', [d.id]);
        quarantined += materializePathway(workspaceId, d.obj, park++, images);   // unique parking order; compacted below
        existed ? replaced++ : added++;
      }
      // keep-local / noop → nothing
    }
    // Reconcile pathway order: remote manifest order first, local-only pathways appended.
    const all = db.selectObjects('SELECT id FROM pathways WHERE workspace_id=? ORDER BY sort_order', [workspaceId]).map((r) => r.id);
    const pos = new Map(remoteOrder.map((id, i) => [id, i]));
    const rank = (id) => (pos.has(id) ? pos.get(id) : remoteOrder.length + all.indexOf(id));
    all.sort((a, b) => rank(a) - rank(b));
    renumber('pathways', all);

    // GC attachments orphaned by a swapped-out or removed header image (dedup-safe: an attachment
    // still referenced by any pathway/inbox row survives, even if shared).
    if (added || replaced || deleted) {
      db.exec(`DELETE FROM attachments WHERE id NOT IN (
        SELECT header_image_id FROM pathways WHERE header_image_id IS NOT NULL
        UNION SELECT image_blob_id FROM inbox WHERE image_blob_id IS NOT NULL)`);
    }

    if (commitSha) {
      const prev = syncStateObj(workspaceId);
      db.exec({ sql: `INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        bind: [`sync_state:${workspaceId}`, JSON.stringify({
          schemaVersion: 1, lastCommitSha: commitSha, lastTreeSha: treeSha,
          lastCommitHash: workspaceHash, manifestHash, lastSyncedAt: Date.now(),
          files: filesMap || {}, connectedAt: prev.connectedAt ?? Date.now(),
        })] });
    }
  });
  return { added, replaced, deleted, quarantined };
}

// ===== P4: inbox (the capture-drain destination) =====
const nextInboxOrder = () => db.selectValue('SELECT COALESCE(MAX(sort_order),-1)+1 FROM inbox');

// Idempotent insert (ON CONFLICT(ref) DO NOTHING): a re-drained payload with the same ref is a
// no-op. url_norm is computed HERE (worker) — it is NOT NULL and the main-thread drain can't call
// normalizeUrl. Every drained/manual item carries a minted (non-null) ref (NULLs wouldn't dedup).
function addInboxItem({ id, url, title = null, note = null, description = null, image_url = null, content_type = 'Read', source, ref, created_at }) {
  assertContentType(content_type);
  const rowId = id || crypto.randomUUID();
  db.exec({
    sql: `INSERT INTO inbox (id,url,url_norm,title,note,description,image_url,content_type,source,ref,status,sort_order,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?, 'unsorted', ?, ?)
          ON CONFLICT(ref) DO NOTHING`,
    bind: [rowId, url, normalizeUrl(url || ''), title, note, description, image_url,
           content_type, source, ref, nextInboxOrder(), created_at ?? Date.now()],
  });
  return { id: rowId };
}
const listInbox = ({ status = 'unsorted' } = {}) =>
  db.selectObjects('SELECT * FROM inbox WHERE status=? ORDER BY created_at DESC, sort_order DESC', [status]);
const countInboxUnsorted = () => db.selectValue("SELECT count(*) FROM inbox WHERE status='unsorted'");
function updateInboxStatus({ id, status }) {
  if (!['unsorted', 'triaged', 'dismissed'].includes(status)) throw new Error('Invalid inbox status.');
  db.exec({ sql: 'UPDATE inbox SET status=?, triaged_at=? WHERE id=?', bind: [status, status === 'unsorted' ? null : Date.now(), id] });
  return { id };
}
const deleteInboxItem = ({ id }) => { db.exec({ sql: 'DELETE FROM inbox WHERE id=?', bind: [id] }); return { id }; };

// File an inbox item into a step → a URL-guarded bookmark (assertSafeUrl, exactly like createBookmark),
// mark the item triaged, and link filed_bookmark_id. One transaction. Fields NOT passed fall back to
// what capture collected — the page's meta description, and the user's own note → context — so
// filing never silently strips them; an explicit '' (a cleared field) is respected ('' isn't nullish).
function triageInboxItem({ id, step_id, title, url, description, context, required = 1, content_type }) {
  if (!step_id) throw new Error('Choose a step to file this into.');
  const item = db.selectObject('SELECT * FROM inbox WHERE id=?', [id]);
  if (!item) throw new Error('Inbox item not found.');
  const ct = content_type ?? item.content_type ?? 'Read';
  const safe = assertSafeUrl(url ?? item.url); assertContentType(ct);
  const bmId = crypto.randomUUID();
  db.transaction(() => {
    db.exec({
      sql: `INSERT INTO bookmarks (id,step_id,title,url,url_norm,description,context,required,content_type,added_at,sort_order,extra_json)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      bind: [bmId, step_id, String(title ?? item.title ?? '').trim(), safe, normalizeUrl(safe),
             description ?? item.description ?? '', context ?? item.note ?? '',
             required ? 1 : 0, ct, Date.now(), nextOrder('bookmarks', 'step_id', step_id), null],
    });
    db.exec({ sql: "UPDATE inbox SET status='triaged', triaged_at=?, filed_bookmark_id=? WHERE id=?", bind: [Date.now(), bmId, id] });
    touchPathway(pathwayIdOfStep(step_id));
  });
  return { id, bookmarkId: bmId };
}

// ===== P5: link audit (results channel + exempt domains) =====
const auditHostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const hostExempt = (host, exempt) => !!host && exempt.some((d) => host === d || host.endsWith('.' + d));
const AUDIT_CLEAR_SQL = `UPDATE bookmarks SET last_checked=NULL, available=NULL, http_status=NULL, status_label=NULL,
  redirect_url=NULL, check_error=NULL, requires_auth=NULL, check_method=NULL, check_duration=NULL WHERE id=?`;

// A soft manual override ('manual') protects a link from the auditor for this long, then EXPIRES —
// the next merge is allowed to overwrite it and auto-scanning resumes. A hard override ('pinned')
// never expires. 90 days (change here to retune). Anchor is last_checked (set when the override is applied).
const AUDIT_MANUAL_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// Merge audit results into THIS workspace's bookmarks by (committed) url_norm. Idempotent; writes
// ONLY audit columns (hash-excluded → never dirties a pathway). redirect_url/status_label are
// UNTRUSTED remote strings → coerce numerics, cap text, and drop a non-http(s) redirect (the UI
// sanitizes too). A 'pinned' row is never overwritten; a 'manual' row is protected only while it's
// still within its TTL (last_checked > cutoff). Returns how many bookmark rows matched.
function mergeAuditResults({ workspaceId, results = {}, checkMethod = 'github-action' }) {
  let updated = 0;
  const cutoff = Date.now() - AUDIT_MANUAL_TTL_MS;   // manual overrides older than this are re-scannable
  // A results file can predate a newly-added exemption (the Action only honours config.json on its
  // NEXT run) — never let stale verdicts re-flag an exempt domain.
  const exempt = db.selectObjects('SELECT domain FROM exempt_domains').map((r) => r.domain);
  db.transaction(() => {
    for (const [urlNorm, r] of Object.entries(results || {})) {
      if (exempt.length && hostExempt(auditHostOf(urlNorm), exempt)) continue;
      const redirect = r && /^https?:\/\//i.test(String(r.redirectUrl ?? '')) ? String(r.redirectUrl) : null;
      db.exec({
        sql: `UPDATE bookmarks SET last_checked=?, available=?, http_status=?, status_label=?, redirect_url=?,
                check_error=?, requires_auth=?, check_method=?, check_duration=?
              WHERE url_norm=?
                AND NOT (check_method IS 'pinned' OR (check_method IS 'manual' AND last_checked > ?))
                AND step_id IN (
                SELECT s.id FROM steps s JOIN pathways p ON p.id=s.pathway_id WHERE p.workspace_id IS ?)`,
        bind: [Number(r?.checkedAt) || Date.now(), r?.available ? 1 : 0,
               Number.isInteger(r?.httpStatus) ? r.httpStatus : null,
               r?.statusLabel != null ? String(r.statusLabel).slice(0, 40) : null,
               redirect != null ? redirect.slice(0, 500) : null, r?.checkError != null ? String(r.checkError).slice(0, 200) : null,
               r?.requiresAuth ? 1 : 0, String(checkMethod).slice(0, 20),
               Number.isInteger(r?.durationMs) ? r.durationMs : null,
               String(urlNorm), cutoff, workspaceId],
      });
      updated += db.selectValue('SELECT changes()');
    }
  });
  return { updated };
}

const listExemptDomains = () => db.selectObjects('SELECT domain, reason FROM exempt_domains ORDER BY domain');

// Upsert an exemption AND clear any stale audit status for bookmarks it now covers (so a link that
// was "broken" stops showing broken the moment it's exempted). Host match is exact-or-subdomain.
// NOT transactional — callers own the transaction (addExemptDomain, mergeExemptDomains).
function applyExemptUpsert(d, reason) {
  db.exec({ sql: 'INSERT INTO exempt_domains (domain,reason) VALUES (?,?) ON CONFLICT(domain) DO UPDATE SET reason=excluded.reason', bind: [d, String(reason || '')] });
  for (const b of db.selectObjects('SELECT id,url FROM bookmarks WHERE last_checked IS NOT NULL')) {
    if (hostExempt(auditHostOf(b.url), [d])) db.exec({ sql: AUDIT_CLEAR_SQL, bind: [b.id] });
  }
}
function addExemptDomain({ domain, reason = '' }) {
  const d = String(domain || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!d || !/[.]/.test(d)) throw new Error('Enter a domain like example.com.');
  db.transaction(() => applyExemptUpsert(d, reason));
  return { domain: d };
}
const removeExemptDomain = ({ domain }) => { db.exec({ sql: 'DELETE FROM exempt_domains WHERE domain=?', bind: [String(domain || '').trim().toLowerCase()] }); return { domain }; };

// ---- P5: committed exemptions side-channel (audit/config.json) ----
// Exemptions must TRAVEL like overrides: the Action reads audit/config.json, and other devices
// need the same list or a pulled results-merge would re-flag what one device exempted. serialize
// feeds the commit; merge applies a pulled file with the same per-domain three-way as overrides
// (base = the file as of the last sync; local changes win; remote adds/removes/reason-edits apply).
const serializeExemptDomains = () => ({ exempt: db.selectObjects('SELECT domain, reason FROM exempt_domains ORDER BY domain') });
function normExemptList(list) {
  const m = new Map();
  for (const e of list || []) {
    const d = String(e?.domain ?? e ?? '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
    if (d && /[.]/.test(d)) m.set(d, String(e?.reason ?? ''));
  }
  return m;
}
function mergeExemptDomains({ remote = [], base = [] }) {
  const R = normExemptList(remote), B = normExemptList(base);
  const L = new Map(db.selectObjects('SELECT domain, reason FROM exempt_domains').map((r) => [r.domain, r.reason]));
  let added = 0, removed = 0;
  db.transaction(() => {
    for (const d of new Set([...R.keys(), ...B.keys()])) {
      const r = R.has(d) ? R.get(d) : null, b = B.has(d) ? B.get(d) : null, l = L.has(d) ? L.get(d) : null;
      if (l !== b) continue;                                // local changed since last sync → local wins
      if (r === b) continue;                                // remote unchanged → nothing to adopt
      if (r !== null) { applyExemptUpsert(d, r); added++; }
      else { db.exec({ sql: 'DELETE FROM exempt_domains WHERE domain=?', bind: [d] }); removed++; }
    }
  });
  return { added, removed, normalized: [...R.entries()].map(([domain, reason]) => ({ domain, reason })) };
}

// Every audited bookmark that's flagged (unavailable / redirected / auth-walled) OR manually set
// (soft 'manual' or hard 'pinned'), with its pathway + workspace context — for the #/audit overview.
// Manual rows are annotated with their override kind and, for soft ones, how many days until the
// override expires and the auditor takes over again (negative/0 → already expired, re-scannable).
function listFlaggedBookmarks() {
  const rows = db.selectObjects(`
    SELECT b.id, b.title, b.url, b.available, b.http_status, b.status_label, b.redirect_url, b.requires_auth,
           b.check_method, b.check_error, b.last_checked,
           p.id AS pathway_id, p.name AS pathway_name, w.org_label AS workspace
      FROM bookmarks b
      JOIN steps s ON s.id = b.step_id
      JOIN pathways p ON p.id = s.pathway_id
      LEFT JOIN workspaces w ON w.id = p.workspace_id
     WHERE b.last_checked IS NOT NULL
       AND (b.available = 0 OR b.redirect_url IS NOT NULL OR b.requires_auth = 1 OR b.check_method IN ('manual','pinned'))
     ORDER BY b.available, w.org_label, p.name, b.title`);
  const now = Date.now();
  return rows.map((b) => {
    if (b.check_method === 'pinned') return { ...b, override: 'pinned' };
    if (b.check_method === 'manual' && b.last_checked != null) {
      const expiresAt = b.last_checked + AUDIT_MANUAL_TTL_MS;
      return { ...b, override: 'soft', expires_at: expiresAt, days_left: Math.ceil((expiresAt - now) / 86400000) };
    }
    return { ...b, override: null };
  });
}

// P8: the URL list for an extension-side audit of ONE workspace (workspaceId null = pathways with
// no workspace). {url_norm, url} pairs, first occurrence per norm (mirror audit.mjs: FETCH url,
// key results by url_norm), excluding exempt hosts and active overrides — URLs the curator opted
// out of are never even fetched.
function listAuditUrls({ workspaceId = null } = {}) {
  const exempt = db.selectObjects('SELECT domain FROM exempt_domains').map((r) => r.domain);
  const cutoff = Date.now() - AUDIT_MANUAL_TTL_MS;
  const rows = db.selectObjects(`
    SELECT b.url, b.url_norm, b.check_method, b.last_checked
      FROM bookmarks b JOIN steps s ON s.id=b.step_id JOIN pathways p ON p.id=s.pathway_id
     WHERE p.workspace_id IS ? ORDER BY p.sort_order, s.sort_order, b.sort_order`, [workspaceId]);
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const norm = r.url_norm || r.url;
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    if (exempt.length && hostExempt(auditHostOf(r.url), exempt)) continue;
    if (r.check_method === 'pinned') continue;
    if (r.check_method === 'manual' && (r.last_checked ?? 0) > cutoff) continue;
    out.push({ url_norm: norm, url: r.url });
  }
  return out;
}

// Manual audit override for a single bookmark. Two strengths:
//   'good'/'broken' → check_method='manual' (SOFT): protected from merge for AUDIT_MANUAL_TTL_MS, then
//                     it expires and the auditor takes over again.
//   'pin'           → check_method='pinned' (HARD): "always good, never re-check" — never expires.
//   'auto'          → clear the override; the next audit decides.
function setBookmarkAuditStatus({ id, status }) {
  const at = Date.now();
  if (status === 'good') db.exec({ sql: `UPDATE bookmarks SET available=1, http_status=NULL, status_label='Verified OK',
    redirect_url=NULL, requires_auth=0, check_error=NULL, check_method='manual', check_duration=NULL, last_checked=? WHERE id=?`, bind: [at, id] });
  else if (status === 'pin') db.exec({ sql: `UPDATE bookmarks SET available=1, http_status=NULL, status_label='Verified OK (pinned)',
    redirect_url=NULL, requires_auth=0, check_error=NULL, check_method='pinned', check_duration=NULL, last_checked=? WHERE id=?`, bind: [at, id] });
  else if (status === 'broken') db.exec({ sql: `UPDATE bookmarks SET available=0, http_status=NULL, status_label='Marked broken',
    redirect_url=NULL, requires_auth=0, check_error=NULL, check_method='manual', check_duration=NULL, last_checked=? WHERE id=?`, bind: [at, id] });
  else if (status === 'auto') db.exec({ sql: `UPDATE bookmarks SET available=NULL, http_status=NULL, status_label=NULL,
    redirect_url=NULL, requires_auth=NULL, check_error=NULL, check_method=NULL, check_duration=NULL, last_checked=NULL WHERE id=?`, bind: [id] });
  else throw new Error('Invalid audit status.');
  return { id };
}

// ---- P5: committed overrides side-channel (audit/overrides.json) ----
// Manual overrides travel between devices in a committed file keyed by url_norm — the same lane as
// results.json, so they never dirty a pathway. serialize builds the file's map from this workspace's
// bookmark columns; merge applies a pulled file with a per-URL THREE-WAY (base = the file as of the
// last sync): if THIS device changed an override since then, local wins (it commits later);
// otherwise the remote state is adopted — including clears (in base, absent remotely = another
// device pressed "Auto"). Remote entries are UNTRUSTED repo content → normalized/coerced.
function normOverrideEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const method = e.method === 'pinned' ? 'pinned' : e.method === 'manual' ? 'manual' : null;
  const setAt = Number(e.setAt);
  if (!method || !Number.isFinite(setAt)) return null;
  return { available: e.available ? 1 : 0, method, setAt };
}
const sameOverride = (a, b) => (!a && !b) || (!!a && !!b && a.available === b.available && a.method === b.method && a.setAt === b.setAt);
// Per-URL local override state. Same URL in several bookmarks → newest setAt wins (ORDER BY).
function localOverrideMap(workspaceId) {
  const map = new Map();
  for (const r of db.selectObjects(`
    SELECT b.url_norm, b.available, b.check_method AS method, b.last_checked AS setAt
      FROM bookmarks b JOIN steps s ON s.id=b.step_id JOIN pathways p ON p.id=s.pathway_id
     WHERE p.workspace_id=? AND b.check_method IN ('manual','pinned') AND b.url_norm IS NOT NULL
     ORDER BY b.url_norm, b.last_checked`, [workspaceId]))
    map.set(r.url_norm, { available: r.available ? 1 : 0, method: r.method, setAt: r.setAt ?? 0 });
  return map;
}
function serializeAuditOverrides({ workspaceId }) {
  const overrides = {};
  for (const [u, e] of [...localOverrideMap(workspaceId).entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) overrides[u] = e;
  return { overrides };
}
function mergeAuditOverrides({ workspaceId, remote = {}, base = {} }) {
  const local = localOverrideMap(workspaceId);
  const normalized = {};           // the remote file as understood → stored as the new sync base
  let applied = 0, cleared = 0;
  const scope = 'AND step_id IN (SELECT s.id FROM steps s JOIN pathways p ON p.id=s.pathway_id WHERE p.workspace_id=?)';
  db.transaction(() => {
    for (const u of new Set([...Object.keys(remote || {}), ...Object.keys(base || {})])) {
      const r = normOverrideEntry(remote?.[u]);
      if (r) normalized[u] = r;
      const b = normOverrideEntry(base?.[u]);
      if (!sameOverride(local.get(u) || null, b)) continue;   // local changed since last sync → local wins
      if (sameOverride(r, b)) continue;                       // remote unchanged → nothing to adopt
      if (r) {
        const label = r.available ? (r.method === 'pinned' ? 'Verified OK (pinned)' : 'Verified OK') : 'Marked broken';
        db.exec({ sql: `UPDATE bookmarks SET available=?, http_status=NULL, status_label=?, redirect_url=NULL,
            requires_auth=0, check_error=NULL, check_method=?, check_duration=NULL, last_checked=?
          WHERE url_norm=? ${scope}`, bind: [r.available, label, r.method, r.setAt, u, workspaceId] });
        applied += db.selectValue('SELECT changes()');
      } else {
        db.exec({ sql: `UPDATE bookmarks SET available=NULL, http_status=NULL, status_label=NULL, redirect_url=NULL,
            requires_auth=NULL, check_error=NULL, check_method=NULL, check_duration=NULL, last_checked=NULL
          WHERE url_norm=? AND check_method IN ('manual','pinned') ${scope}`, bind: [u, workspaceId] });
        cleared += db.selectValue('SELECT changes()');
      }
    }
  });
  return { applied, cleared, normalized };
}

const OPS = {
  counts, listPathways, getWorkspaces, getPathwayDeep, importWorkspace, reset,   // EXISTING
  exec: ({ sql, bind }) => db.selectObjects(sql, bind || []),                     // EXISTING
  // reads
  getSetting:    (key) => db.selectValue('SELECT value FROM settings WHERE key=?', [key]),
  getAttachment: (id)  => db.selectObject('SELECT id,mime,bytes,byte_len,sha256 FROM attachments WHERE id=?', [id]),
  // settings write
  setSetting: ({ key, value }) => {
    db.exec({ sql: `INSERT INTO settings(key,value) VALUES(?,?)
                    ON CONFLICT(key) DO UPDATE SET value=excluded.value`, bind: [key, value] });
    return { key };
  },
  // writes
  createPathway, updatePathway, deletePathway,
  createStep, updateStep, deleteStep,
  createBookmark, updateBookmark, deleteBookmark,
  moveEntity,
  setHeaderImage, removeHeaderImage,
  renameWorkspace, deleteWorkspace,
  // ===== P3 sync =====
  createWorkspace, getWorkspaceFull, setWorkspaceRepo, setWorkspaceRepoMeta,
  getSyncState, setSyncState, markCommitted,
  serializeWorkspace, getUncommittedCount, serializePathway,
  getLocalHashes, hasAttachmentSha, applyPull, importPathwaysIntoWorkspace,
  exportPathwayData, exportWorkspaceData, exportBackupData,
  // ===== P4 inbox =====
  addInboxItem, listInbox, countInboxUnsorted, updateInboxStatus, deleteInboxItem, triageInboxItem,
  // ===== P5 link audit =====
  mergeAuditResults, listExemptDomains, addExemptDomain, removeExemptDomain,
  serializeExemptDomains, mergeExemptDomains,
  listFlaggedBookmarks, setBookmarkAuditStatus, serializeAuditOverrides, mergeAuditOverrides, listAuditUrls,
};

self.onmessage = async (e) => {
  const { id, op, args } = e.data;
  try {
    const meta = await ready;
    if (!OPS[op]) throw new Error('unknown op: ' + op);
    const value = op === 'counts' && args?.withMeta ? { ...OPS[op](args), meta } : OPS[op](args);
    // P3 ops (serialize/commit/merge) are async — await thenables; sync ops pass straight through.
    const result = value && typeof value.then === 'function' ? await value : value;
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
