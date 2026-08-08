// src/data/exchange.js — P6 file exchange: build self-contained export files and plan/apply imports.
// Pure logic, no DOM. One canonical shape everywhere: exports carry the exact committed pathway
// shape (serializePathway) with header-image bytes inlined base64; imports are UNTRUSTED — parsed
// defensively, size-capped, classified per stable id against LOCAL FACTS (existsIn + hashEqual;
// the dialog derives new/identical/conflict/elsewhere against the chosen target), normalized the
// same way materializePathway will normalize (title trim, unsafe URL/content-type drops → surfaced
// as warnings, unavailable header image → null) so "identical" and idempotent re-import are real.
// The worker re-verifies image hashes independently (defense in depth).
import { contentHash } from './canonical.js';
import { convertLegacyPathways, canonicalContentType } from './legacy.js';

const PARSE_CAP = 50 * 1024 * 1024;      // raw file text
const PATHWAY_CAP = 500;                 // per import (backup kind exempt)
const CONTENT_TYPES = new Set(['Read', 'Watch', 'Listen', 'Participate']);
export const KINDS = ['pathcurator-pathway', 'pathcurator-workspace', 'pathcurator-backup'];

// ---- bytes ⇄ base64 (chunked — String.fromCharCode(...bigArray) blows the arg limit) ----
export function b64FromBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function bytesFromB64(b64) {
  const s = atob(String(b64 || '').replace(/\s+/g, ''));
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

export const slugify = (s) => String(s || 'export').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'export';
const today = () => new Date().toISOString().slice(0, 10);
const imagesOut = (images) => Object.fromEntries(Object.entries(images || {}).map(([sha, i]) =>
  [sha, { dataBase64: b64FromBytes(i.bytes instanceof Uint8Array ? i.bytes : new Uint8Array(i.bytes)), mime: i.mime, ext: i.ext }]));

// ============================== EXPORT ==============================
// scope: 'pathway' | 'workspace' | 'backup'. Returns { content, filename, oversized }.
export async function buildExportFile(db, { scope, id }) {
  let payload, filename;
  if (scope === 'pathway') {
    const d = await db.exportPathwayData(id);
    payload = { schemaVersion: 1, kind: 'pathcurator-pathway', exportedAt: Date.now(), pathway: d.obj.pathway, images: imagesOut(d.images) };
    filename = `${slugify(d.obj.pathway.name)}--pathway--${today()}.json`;
  } else if (scope === 'workspace') {
    const d = await db.exportWorkspaceData(id);
    payload = { schemaVersion: 1, kind: 'pathcurator-workspace', exportedAt: Date.now(),
      workspace: { slug: slugify(d.workspace.org_label), orgLabel: d.workspace.org_label, colour: d.workspace.colour ?? null },
      pathways: d.pathways, overrides: d.overrides, images: imagesOut(d.images) };
    filename = `${slugify(d.workspace.org_label)}--workspace--${today()}.json`;
  } else if (scope === 'backup') {
    const d = await db.exportBackupData();
    payload = { schemaVersion: 1, kind: 'pathcurator-backup', exportedAt: Date.now(),
      workspaces: d.workspaces.map((w) => ({
        workspace: { slug: slugify(w.workspace.org_label), orgLabel: w.workspace.org_label, colour: w.workspace.colour ?? null,
          repo: w.workspace.owner ? { owner: w.workspace.owner, repo: w.workspace.repo, branch: w.workspace.branch, path: w.workspace.path } : null },
        pathways: w.pathways, overrides: w.overrides })),
      exemptDomains: d.exempt, images: imagesOut(d.images) };
    filename = `pathcurator-backup--${today()}.json`;
  } else throw new Error(`Unknown export scope: ${scope}`);
  const content = JSON.stringify(payload, null, 2) + '\n';
  return { content, filename, oversized: content.length > PARSE_CAP };
}

// ============================== DETECT ==============================
const isV2Wrap = (e) => e && typeof e === 'object' && e.pathway && typeof e.pathway === 'object' && e.pathway.id != null;
const isLegacyEntry = (e) => e && typeof e === 'object' && !e.pathway &&
  (Array.isArray(e.steps) || 'contentWarning' in e || 'headerImage' in e || 'pauseAndReflect' in e);
const isManifestEntry = (e) => e && typeof e === 'object' && 'file' in e && !('steps' in e) && !e.pathway;

// → { kind } or throws a descriptive Error. kinds: the three export kinds + 'raw-pathway' (a
// downloaded pathways/<id>.json), 'v2-pathway-list' (array of wrappers), 'legacy'.
export function detectKind(json) {
  if (json && KINDS.includes(json.kind)) return { kind: json.kind };
  if (isV2Wrap(json)) return { kind: 'raw-pathway' };
  if (Array.isArray(json)) {
    if (json.length && json.every(isV2Wrap)) return { kind: 'v2-pathway-list' };
    if (json.length && json.some(isLegacyEntry)) return { kind: 'legacy' };
  }
  if (json && Array.isArray(json.pathways)) {
    if (json.pathways.some(isManifestEntry))
      throw new Error('This is a workspace manifest (manifest.json) — it lists pathways but contains none. Import the pathway files themselves, or use a workspace export.');
    if (json.pathways.length && json.pathways.some(isLegacyEntry)) return { kind: 'legacy' };
  }
  throw new Error('Not a recognized PathCurator file (expected a pathway/workspace/backup export, a committed pathway file, or a legacy curator-pathways.json).');
}

// ============================== CSV import ==============================
// Round-trips our own CSV export and accepts any sheet with a URL column (optional Step/Title/
// Type/Required/Description/Context/Added columns). The export's formula-injection guard
// (leading apostrophe before =+-@) is stripped back off, so round trips are faithful.
function stripBom(t) { return t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t; }
export function parseCsv(text) {
  const rows = []; let row2 = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row2.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row2.push(field); field = '';
      if (row2.length > 1 || row2[0] !== '') rows.push(row2);
      row2 = [];
    } else field += c;
  }
  if (field !== '' || row2.length) { row2.push(field); rows.push(row2); }
  return rows;
}
const unguard = (s) => (/^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s);
export function looksLikeCsv(text) {
  const first = stripBom(String(text)).split(/\r?\n/, 1)[0] || '';
  return /^"?Pathway Name"?,/i.test(first) || (first.includes(',') && /(^|,)\s*"?(url|link)"?\s*(,|$)/i.test(first));
}
export function csvToPathways(text, { fallbackName = 'Imported links' } = {}) {
  const rows = parseCsv(stripBom(String(text))).map((r) => r.map(unguard));
  let name = fallbackName, description = '', contentWarning = '';
  const hi = rows.findIndex((r) => r.some((c) => /^(url|link)$/i.test(c.trim())));
  if (hi === -1) throw new Error('No URL column found in the CSV.');
  for (let i = 0; i < hi; i++) {
    const k = (rows[i][0] || '').trim().toLowerCase(), v = rows[i][1] || '';
    if (k === 'pathway name' && v) name = v;
    else if (k === 'pathway description') description = v;
    else if (k === 'content warning') contentWarning = v;
  }
  const header = rows[hi].map((c) => c.trim().toLowerCase());
  const col = (n) => header.indexOf(n);
  const iStep = col('step'), iTitle = col('title'), iType = col('type'), iReq = col('required'),
    iDesc = col('description'), iCtx = col('context'), iAdded = col('added'),
    iUrl = header.findIndex((c) => c === 'url' || c === 'link');
  const stepMap = new Map();
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    const url = (iUrl >= 0 ? r[iUrl] : '')?.trim();
    if (!url) continue;
    const stepName = (iStep >= 0 && r[iStep]?.trim()) ? r[iStep].trim() : 'Links';
    if (!stepMap.has(stepName)) stepMap.set(stepName, []);
    const added = iAdded >= 0 && r[iAdded] ? Date.parse(r[iAdded]) : NaN;
    stepMap.get(stepName).push({
      title: (iTitle >= 0 && r[iTitle]) || url, url,
      content_type: canonicalContentType(iType >= 0 ? r[iType] : ''),
      required: iReq >= 0 && r[iReq] ? (/^(required|yes|y|true|1)$/i.test(r[iReq].trim()) ? 1 : 0) : 1,
      description: (iDesc >= 0 && r[iDesc]) || '', context: (iCtx >= 0 && r[iCtx]) || '',
      added_at: Number.isFinite(added) ? added : null,
    });
  }
  if (![...stepMap.values()].some((v) => v.length)) throw new Error('The CSV contains no links.');
  const id = `csv--${slugify(name)}`;
  const steps = [...stepMap.entries()].map(([stepName, items], si) => ({
    id: `${id}-s${si}`, name: stepName, objective: '', pause_and_reflect: '', sort_order: si,
    bookmarks: items.map((b, bi) => ({ id: `${id}-s${si}-b${bi}`, sort_order: bi, ...b })),
  }));
  return { pathways: [{ schemaVersion: 1, pathway: {
    id, name, description, content_warning: contentWarning, acknowledgments: '', sort_order: 0,
    created_at: null, last_updated: null, version: null, created_by: null, modified_by: null,
    header_image: null, version_history: [], extra: {}, steps,
  } }], images: {} };
}

// ============================== PLAN ==============================
// Normalize an incoming pathway EXACTLY the way materializePathway will, so the classification
// hash matches what the DB would hold after import (→ honest "identical", idempotent re-import).
function normalizeIncoming(pw, imageShas, safeUrl, warnings) {
  const p = JSON.parse(JSON.stringify(pw));                       // never mutate the parsed file
  if (p.header_image?.sha256 && !imageShas.has(p.header_image.sha256)) {
    warnings.push(`“${p.name}”: header image data missing from the file — imported without it.`);
    p.header_image = null;
  }
  for (const s of p.steps || []) {
    s.bookmarks = (s.bookmarks || []).filter((b) => {
      const ok = typeof b?.url === 'string' && safeUrl(b.url) && CONTENT_TYPES.has(b.content_type ?? 'Read');
      if (!ok) warnings.push(`“${p.name}”: link “${b?.title || b?.url || '?'}” skipped (unsafe URL or invalid type).`);
      else b.title = String(b.title ?? '').trim();
      return ok;
    });
  }
  return p;
}

// → { kind, items, images, warnings, workspaceMeta?, groups?, exemptDomains?, overridesByGroup? }
// items: [{ id, name, pathway (normalized wrap), hash, existsIn: wsId|null, existsInLabel, localHash }]
export async function planImport(db, text, { safeUrl, filename = '' } = {}) {
  if (typeof text !== 'string' || text.length > PARSE_CAP) throw new Error('File is too large to import (50 MB cap).');
  const fallbackName = String(filename).replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim() || 'Imported links';
  let json = null, alt = null;
  try { json = JSON.parse(text); } catch {
    // Non-JSON inputs: a browser bookmarks.html (Netscape format) or a CSV of links.
    const { looksLikeNetscape, parseNetscapeBookmarks } = await import('./netscape.js');
    if (looksLikeNetscape(text)) alt = { kind: 'bookmarks', ...parseNetscapeBookmarks(text, { fallbackName }) };
    else if (looksLikeCsv(text)) alt = { kind: 'csv', ...csvToPathways(text, { fallbackName }) };
    else throw new Error('Not a recognized file — expected a PathCurator JSON export, a legacy curator-pathways.json, a CSV of links, or a browser bookmarks.html.');
  }
  const kind = alt ? alt.kind : detectKind(json).kind;

  // Assemble the raw pathway list (+ per-group metadata for workspace/backup kinds).
  let images = {};
  const groups = [];         // [{ workspace: {slug, orgLabel, colour, repo?}, pathwayIds: [], overrides }]
  let list = [];
  if (alt) { list = alt.pathways; }
  else if (kind === 'pathcurator-pathway') { list = [{ pathway: json.pathway }]; images = json.images || {}; }
  else if (kind === 'raw-pathway') list = [{ pathway: json.pathway }];
  else if (kind === 'v2-pathway-list') list = json.map((e) => ({ pathway: e.pathway }));
  else if (kind === 'pathcurator-workspace') {
    list = json.pathways || []; images = json.images || {};
    groups.push({ workspace: json.workspace || {}, pathwayIds: list.map((w) => String((w.pathway ?? w)?.id)), overrides: json.overrides || {} });
  } else if (kind === 'pathcurator-backup') {
    images = json.images || {};
    for (const w of json.workspaces || []) {
      const pws = w.pathways || [];
      groups.push({ workspace: w.workspace || {}, pathwayIds: pws.map((x) => String((x.pathway ?? x)?.id)), overrides: w.overrides || {} });
      list = list.concat(pws);
    }
  } else if (kind === 'legacy') {
    const conv = await convertLegacyPathways(json);
    list = conv.pathways;
    images = Object.fromEntries(Object.entries(conv.images).map(([sha, i]) => [sha, { dataBase64: b64FromBytes(i.bytes), mime: i.mime, ext: i.ext }]));
  }
  if (!list.length) throw new Error('The file contains no pathways.');
  if (kind !== 'pathcurator-backup' && list.length > PATHWAY_CAP) throw new Error(`Too many pathways in one file (${list.length} > ${PATHWAY_CAP}).`);

  // Decode images once (worker re-verifies hashes; this is transport decoding only).
  const imgBytes = {};
  for (const [sha, i] of Object.entries(images)) {
    try { imgBytes[sha] = { bytes: bytesFromB64(i.dataBase64), mime: i.mime, ext: i.ext }; } catch { /* skip undecodable */ }
  }
  const imageShas = new Set(Object.keys(imgBytes));

  const wsById = new Map((await db.getWorkspaces()).map((w) => [w.id, w]));
  const warnings = [];
  const items = [];
  const seen = new Set();
  for (const wrap of list) {
    const p0 = wrap?.pathway ?? wrap;
    if (!p0?.id || !p0?.name || seen.has(String(p0.id))) continue;
    seen.add(String(p0.id));
    const p = normalizeIncoming(p0, imageShas, safeUrl, warnings);
    const hash = await contentHash(p);
    let existsIn = null, localHash = null, localName = null;
    const local = await db.getPathway(String(p.id)).catch(() => null);
    if (local) {
      existsIn = local.workspace_id ?? null;
      localName = local.name;
      const ser = await db.serializePathway(String(p.id));
      localHash = ser?.contentHash ?? null;
    }
    items.push({ id: String(p.id), name: p.name, pathway: { schemaVersion: 1, pathway: p }, hash,
      existsIn, existsInLabel: existsIn ? (wsById.get(existsIn)?.org_label ?? 'another workspace') : null,
      localHash, localName, identical: localHash !== null && localHash === hash });
  }
  if (!items.length) throw new Error('No importable pathways found in the file.');
  return { kind, items, images: imgBytes, warnings, groups,
    exemptDomains: kind === 'pathcurator-backup' ? (json.exemptDomains || []) : null };
}

// Pick a target workspace for a group: slug match CONFIRMED by pathway-id overlap; else null (create).
export function matchGroupTarget(group, workspaces, items) {
  const bySlug = workspaces.find((w) => slugify(w.org_label) === (group.workspace?.slug || slugify(group.workspace?.orgLabel)));
  if (!bySlug) return null;
  const overlap = items.some((it) => group.pathwayIds.includes(it.id) && it.existsIn === bySlug.id);
  const empty = !items.some((it) => it.existsIn === bySlug.id) && group.pathwayIds.every((id) => !items.find((x) => x.id === id)?.existsIn);
  return overlap || empty ? bySlug : null;
}

// ============================== APPLY ==============================
// resolutions: { [pathwayId]: 'take' | 'keep' } for ids that already exist. plan.items with
// existsIn stay in place on 'take'; new ids go to their group's target (or targetWsId).
// targets: { [groupIndex]: wsId | 'create' } for workspace/backup kinds; targetWsId for the rest.
export async function applyImport(db, plan, { targetWsId = null, targets = {}, resolutions = {} } = {}) {
  const replace = plan.items.filter((it) => it.existsIn && !it.identical && resolutions[it.id] === 'take').map((it) => it.id);
  const totals = { added: 0, replaced: 0, skippedExisting: 0, identical: plan.items.filter((i) => i.identical).length, quarantined: 0, createdWorkspaces: 0 };

  const runImport = async (wsId, wraps) => {
    if (!wraps.length) return;
    const r = await db.importPathwaysIntoWorkspace({ workspaceId: wsId, pathways: wraps, images: plan.images, replace });
    totals.added += r.added; totals.replaced += r.replaced; totals.quarantined += r.quarantined;
    totals.skippedExisting += r.skipped;
  };
  const wrapsFor = (ids) => plan.items.filter((it) => ids.has(it.id) && (!it.existsIn || replace.includes(it.id))).map((it) => it.pathway);

  if (plan.groups.length) {
    for (let g = 0; g < plan.groups.length; g++) {
      const group = plan.groups[g];
      const ids = new Set(group.pathwayIds);
      let wsId = targets[g];
      if (wsId === 'create' || wsId == null) {
        const created = await db.createWorkspace({ org_label: group.workspace?.orgLabel || 'Imported workspace', colour: group.workspace?.colour ?? null });
        wsId = created.id; totals.createdWorkspaces++;
      }
      await runImport(wsId, wrapsFor(ids));
      // Restore the group's audit overrides (local-wins vs an empty base; never deletes local).
      if (group.overrides && Object.keys(group.overrides).length) {
        await db.mergeAuditOverrides({ workspaceId: wsId, remote: group.overrides, base: {} }).catch(() => {});
      }
    }
  } else {
    if (!targetWsId) throw new Error('Choose a workspace to import into.');
    await runImport(targetWsId, wrapsFor(new Set(plan.items.map((i) => i.id))));
  }
  // Backup restore: merge exemptions (adds/updates only — an empty base never deletes local rows).
  if (plan.exemptDomains?.length) {
    const remote = plan.exemptDomains.map((d) => (typeof d === 'string' ? { domain: d, reason: '' } : d));
    await db.mergeExemptDomains({ remote, base: [] }).catch(() => {});
  }
  return totals;
}
