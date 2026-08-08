// PathCurator v2 — pure serializers: DB rows → committed repo-file shapes (P3, worker-side).
// No SQL, no network, no DOM. Objects are built in FIXED key order so
// `JSON.stringify(obj, null, 2) + '\n'` is byte-reproducible (stable diffs, real change detection).
// The committed bookmark projection EXCLUDES all link-audit columns — those are volatile
// per-check state that would manufacture a diff on nearly every commit (audit has its own channel).

export const slug = (s) =>
  String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const EXT_BY_MIME = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
  'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif',
};
export const mimeExt = (mime) => EXT_BY_MIME[String(mime || '').toLowerCase()] || 'bin';

// Uint8Array → base64 (chunked to stay under the argument-count limit).
export function bytesToBase64(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u.length; i += CHUNK) s += String.fromCharCode(...u.subarray(i, i + CHUNK));
  return btoa(s);
}

function parseExtra(extraJson) {
  if (!extraJson) return {};
  try { const v = JSON.parse(extraJson); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

// One bookmark row → committed projection. NO audit columns. url_norm kept (audit channel), raw url kept.
function bookmarkOut(b) {
  return {
    id: b.id,
    title: b.title ?? '',
    url: b.url,
    url_norm: b.url_norm ?? b.url,
    description: b.description ?? '',
    context: b.context ?? '',
    required: b.required ? 1 : 0,
    content_type: b.content_type ?? 'Read',
    added_at: b.added_at ?? null,
    sort_order: b.sort_order ?? 0,
  };
}

function stepOut(s) {
  return {
    id: s.id,
    name: s.name ?? '',
    objective: s.objective ?? '',
    pause_and_reflect: s.pause_and_reflect ?? '',
    sort_order: s.sort_order ?? 0,
    bookmarks: (s.bookmarks ?? []).map(bookmarkOut),
  };
}

// pathway row (+ steps[.bookmarks], version_history rows, resolved headerImage) → committed file object.
// The shape round-trips through db-worker importWorkspace (camelCase version_history; extra object).
export function hydratePathway({ pathway: p, steps = [], versionHistory = [], headerImage = null }) {
  return {
    schemaVersion: 1,
    pathway: {
      id: p.id,
      name: p.name ?? '',
      description: p.description ?? '',
      content_warning: p.content_warning ?? '',
      acknowledgments: p.acknowledgments ?? '',
      sort_order: p.sort_order ?? 0,
      created_at: p.created_at ?? null,
      last_updated: p.last_updated ?? null,
      version: p.version ?? null,
      created_by: p.created_by ?? null,
      modified_by: p.modified_by ?? null,
      header_image: headerImage
        ? { sha256: headerImage.sha256, mime: headerImage.mime, ext: headerImage.ext, file: `images/${headerImage.sha256}.${headerImage.ext}` }
        : null,
      version_history: (versionHistory ?? []).map((v) => ({
        hash: v.hash ?? '',
        timestamp: v.timestamp ?? null,
        stepCount: v.step_count ?? null,
        bookmarkCount: v.bookmark_count ?? null,
        modifiedBy: v.modified_by ?? '',
      })),
      extra: parseExtra(p.extra_json),
      steps: (steps ?? []).map(stepOut),
    },
  };
}

export function buildManifest({ workspace, orgLabel, index, counts, updatedAt }) {
  return {
    schemaVersion: 1,
    workspace,
    orgLabel,
    updatedAt,
    pathways: index.map((e) => ({ id: e.id, file: e.file, sort_order: e.sort_order, name: e.name })),
    counts,
  };
}
