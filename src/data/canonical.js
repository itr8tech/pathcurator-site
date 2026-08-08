// PathCurator v2 — THE single canonical content-hash + version-label module (P3).
// Pure and isomorphic: imported by the SQLite worker (serialize/commit/merge) AND by tests.
// No DOM, no SQL, no network. Never reimplement this logic elsewhere — every hash
// (change detection, merge identity, version label) flows through here so that a
// locally-computed hash always equals the hash of the committed file (no phantom conflicts).

// U+0000 field separator, computed (never embedded literally — keeps this source text-clean).
const NUL = String.fromCharCode(0);
const byOrder = (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0);

// Ordered, id-FREE projection of a pathway's *content*. Array position encodes order,
// so sort_order VALUES are dropped. EXCLUDES: ids, timestamps, link-audit columns,
// version, version_history, created_by/modified_by, extra, url_norm, sort_order values.
// Uses the RAW `url` (url_norm normalizers diverge across clients → non-deterministic).
// NUL is the field separator; any stray NUL inside a value is stripped (our stored content
// is required to be control-char-free — see markdown.js) so it can never forge a separator.
export function canonicalContent(p) {
  const parts = [];
  const push = (v) => parts.push(v == null ? '' : String(v).split(NUL).join(''));
  push(p.name);
  push(p.description);
  push(p.content_warning);
  push(p.acknowledgments);
  push(p.header_image ? p.header_image.sha256 : (p.header_sha256 ?? ''));
  for (const s of (p.steps ?? []).slice().sort(byOrder)) {
    parts.push('S');
    push(s.name);
    push(s.objective);
    push(s.pause_and_reflect);
    for (const b of (s.bookmarks ?? []).slice().sort(byOrder)) {
      parts.push('B');
      push(b.title);
      push(b.url);
      push(b.description);
      push(b.context);
      push(b.required ? '1' : '0');
      push(b.content_type);
    }
  }
  return parts.join(NUL);
}

async function digestHex(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const sha256Hex = (str) => digestHex(new TextEncoder().encode(str));
export const sha256HexBytes = (bytes) => digestHex(bytes);

// 64-char hex content hash: the merge identity + change-detection key for a pathway.
export const contentHash = (p) => sha256Hex(canonicalContent(p));

// Human-facing version label: first 6 hex of the content hash + the commit date (UTC).
// A display/version label, NOT an integrity hash — the full contentHash does the real work.
// N=6 to match the seed format, e.g. 'fc8edf-2025-10-30'.
export const versionLabel = (hex, date = new Date()) =>
  hex.slice(0, 6) + '-' + date.toISOString().slice(0, 10);

// Hash of the ordered manifest index — flips only on add/remove/reorder/rename.
export const manifestHashOf = (orderedIndex) =>
  sha256Hex(JSON.stringify(orderedIndex.map((p) => [p.id, p.sort_order, p.name])));

// Whole-workspace digest = manifest hash + every pathway's content hash (id-sorted).
// The fast "is this workspace dirty?" bit stored as sync_state.lastCommitHash.
export function workspaceHashOf(manifestHash, pathwayHashes /* { id: contentHash } */) {
  const body = Object.keys(pathwayHashes)
    .sort()
    .map((id) => `${id}:${pathwayHashes[id]}`)
    .join(',');
  return sha256Hex(manifestHash + '|' + body);
}
