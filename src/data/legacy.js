// src/data/legacy.js — legacy PathCurator (v1) → v2 conversion (the first P6 slice). The legacy app
// stores a whole workspace in ONE repo file, curator-pathways.json: an ARRAY of pathways with
// camelCase fields, loose content types ("participate", "", null), boolean-ish `required`, no
// step/bookmark ids, and header images inlined as data: URLs. convertLegacyPathways() projects that
// into v2 committed-file pathway objects + an images map (sha256 → {bytes,mime,ext}) — exactly the
// inputs the worker's materializePathway path accepts (url_norm is left absent so the WORKER's own
// normalizer computes it; no converter divergence). Step/bookmark ids are DETERMINISTIC
// (<pathwayId>-s<i>[-b<j>]) so two devices importing the same legacy file mint the same ids and
// merge cleanly instead of duplicating.

export const LEGACY_FILE = 'curator-pathways.json';

const CT = { read: 'Read', watch: 'Watch', listen: 'Listen', participate: 'Participate' };
const contentType = (v) => CT[String(v ?? '').trim().toLowerCase()] || 'Read';
export const canonicalContentType = contentType;   // shared by the CSV importer
const ts = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  const d = Date.parse(v);
  return Number.isFinite(d) ? d : null;
};

const IMG_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
function dataUrlToBytes(u) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(u || ''));
  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';
  let bytes;
  try {
    if (m[2]) {
      const bin = atob(m[3].replace(/\s+/g, ''));
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else bytes = new TextEncoder().encode(decodeURIComponent(m[3]));
  } catch { return null; }                                   // malformed data URL → no image, not a failure
  return { bytes, mime, ext: IMG_EXT[mime] || 'bin' };
}
const sha256Hex = async (bytes) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function convertLegacyPathways(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.pathways) ? raw.pathways : [];
  const images = {};
  const entries = list.map((L, i) => ({ L: L ?? {}, i }));
  // Respect the legacy sortOrder for the imported ordering; fall back to file order.
  entries.sort((a, b) => (Number(a.L.sortOrder ?? a.i) - Number(b.L.sortOrder ?? b.i)) || (a.i - b.i));

  const pathways = [];
  for (const { L, i } of entries) {
    const id = String(L.id ?? `legacy-${i}`);
    let header_image = null;
    const img = L.headerImage ? dataUrlToBytes(L.headerImage) : null;
    if (img) {
      const sha = await sha256Hex(img.bytes);
      images[sha] = img;
      header_image = { sha256: sha, file: `images/${sha}.${img.ext}`, mime: img.mime, ext: img.ext };
    }
    pathways.push({ schemaVersion: 1, pathway: {
      id,
      name: String(L.name ?? L.title ?? `Untitled ${i + 1}`),
      description: L.description ?? '', content_warning: L.contentWarning ?? '', acknowledgments: L.acknowledgments ?? '',
      sort_order: pathways.length,
      created_at: ts(L.created ?? L.createdDate), last_updated: ts(L.lastUpdated ?? L.modifiedDate),
      version: L.version ?? null, created_by: L.createdBy ?? null, modified_by: L.modifiedBy ?? null,
      header_image, extra: {},
      // The legacy versionHistory entries already carry the v2 field names — map defensively anyway.
      version_history: (Array.isArray(L.versionHistory) ? L.versionHistory : []).map((v) => ({
        hash: v?.hash ?? '', timestamp: ts(v?.timestamp) ?? Date.now(),
        stepCount: v?.stepCount ?? null, bookmarkCount: v?.bookmarkCount ?? null, modifiedBy: v?.modifiedBy ?? null,
      })),
      steps: (Array.isArray(L.steps) ? L.steps : []).map((s, si) => ({
        id: `${id}-s${si}`, name: String(s?.name ?? `Step ${si + 1}`), objective: s?.objective ?? '',
        pause_and_reflect: s?.pauseAndReflect ?? '', sort_order: si,
        bookmarks: (Array.isArray(s?.bookmarks) ? s.bookmarks : []).map((b, bi) => ({
          id: `${id}-s${si}-b${bi}`, title: b?.title ?? b?.url ?? '', url: String(b?.url ?? ''),
          description: b?.description ?? '', context: b?.context ?? '',
          required: b?.required ? 1 : 0, content_type: contentType(b?.contentType),
          added_at: ts(b?.addedAt), sort_order: Number.isFinite(Number(b?.sortOrder)) ? Number(b.sortOrder) : bi,
        })),
      })),
    } });
  }
  return { pathways, images };
}
