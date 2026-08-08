// PathCurator v2 — THE single GitHub REST client (P3, main thread).
// Server-free: called directly from the browser with a fine-grained PAT. Verified that
// api.github.com is CORS-enabled for the Git Data endpoints (allow-origin *, safe because
// PAT auth uses the Authorization header, not cookies). Read file contents via the Git Data
// blobs API only — raw.githubusercontent.com / codeload are NOT CORS-enabled.
//
// `fetchImpl` is injectable for unit tests; the app's real seam is ctx.githubFactory, which
// tests swap for the in-memory fake in tests/helpers/fake-github.js (same interface).

export class ConflictError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'ConflictError';
    this.status = 422;
    this.isConflict = true;
    this.detail = detail;
  }
}

// Robust conflict test that works across the real client AND the fake (different class realms):
export const isConflict = (e) => !!e && (e.isConflict === true || e.name === 'ConflictError' || e.status === 422);

export function createGitHubClient({
  owner, repo, branch = 'main', path = '', token,
  fetchImpl = globalThis.fetch.bind(globalThis),
}) {
  const REPO = `https://api.github.com/repos/${owner}/${repo}`;
  const H = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const enc = encodeURIComponent;

  async function api(method, url, body, absolute = false) {
    const res = await fetchImpl((absolute ? '' : REPO) + url, {
      method,
      headers: body ? { ...H, 'Content-Type': 'application/json' } : H,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404) { const e = new Error('not-found'); e.status = 404; throw e; }
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) { const e = new Error(json.message || `GitHub ${res.status}`); e.status = res.status; e.body = json; throw e; }
    return json;
  }

  return {
    owner, repo, branch, path,

    // ---- account / discovery (connect wizard) ----
    getUser: () => api('GET', 'https://api.github.com/user', null, true)
      .then((u) => ({ login: u.login, id: u.id, name: u.name ?? null })),
    listRepos: () => api('GET', 'https://api.github.com/user/repos?per_page=100&sort=updated', null, true)
      .then((rs) => rs.map((r) => ({
        full_name: r.full_name, owner: r.owner.login, name: r.name,
        default_branch: r.default_branch, permissions: r.permissions || {},
      }))),
    getRepo: (o = owner, r = repo) => api('GET', `https://api.github.com/repos/${o}/${r}`, null, true)
      .then((m) => ({
        default_branch: m.default_branch, size: m.size, empty: m.size === 0,
        permissions: m.permissions || { push: false, pull: false, admin: false },
      })),
    async headFile(o, r, filePath, ref) {           // 404/409 → not present / uninitialized
      try {
        const j = await api('GET', `https://api.github.com/repos/${o}/${r}/contents/${filePath}?ref=${enc(ref)}`, null, true);
        return { exists: true, sha: j.sha };
      } catch (e) {
        if (e.status === 404 || e.status === 409) return { exists: false };
        throw e;
      }
    },

    // ---- git data (read) ----
    async getRef() {                                 // null == empty / uninitialized repo (404 OR 409)
      try { const r = await api('GET', `/git/ref/heads/${enc(branch)}`); return { sha: r.object.sha }; }
      catch (e) { if (e.status === 404 || e.status === 409) return null; throw e; }
    },
    getCommit: (sha) => api('GET', `/git/commits/${sha}`)
      .then((c) => ({ sha: c.sha, treeSha: c.tree.sha, parents: (c.parents || []).map((p) => p.sha) })),
    // Repo visibility — the publish flow must warn BEFORE Moodle discovers a private repo the
    // hard way (its server fetches the package URL with no credentials).
    getRepoMeta: () => api('GET', '').then((r) => ({ private: !!r.private, defaultBranch: r.default_branch || 'main' })),
    // Human-facing commit facts for the #/sync overview (message/author/date, not tree plumbing).
    getCommitMeta: (sha) => api('GET', `/git/commits/${sha}`)
      .then((c) => ({ sha: c.sha, message: c.message || '', author: c.author?.name || null, date: c.author?.date || null })),
    getTree: (sha) => api('GET', `/git/trees/${sha}?recursive=1`)
      .then((t) => ({ truncated: !!t.truncated, tree: t.tree })),
    getBlobBytes: (sha) => api('GET', `/git/blobs/${sha}`).then((b) => b64ToBytes(b.content)),
    getBlobJson: (sha) => api('GET', `/git/blobs/${sha}`)
      .then((b) => JSON.parse(new TextDecoder().decode(b64ToBytes(b.content)))),

    // ---- git data (write) ----
    // Trigger a workflow_dispatch run (204, empty body). Fine-grained PATs need Actions: write.
    dispatchWorkflow: ({ file = 'audit.yml' } = {}) => api('POST', `/actions/workflows/${enc(file)}/dispatches`, { ref: branch }).then(() => true),
    createBlob: ({ content, encoding = 'utf-8' }) => api('POST', '/git/blobs', { content, encoding }).then((b) => b.sha),
    createTree: ({ baseTreeSha, entries }) => api('POST', '/git/trees',
      baseTreeSha ? { base_tree: baseTreeSha, tree: entries } : { tree: entries }).then((t) => t.sha),
    createCommit: ({ message, treeSha, parents }) => api('POST', '/git/commits', { message, tree: treeSha, parents }).then((c) => c.sha),
    async updateRef({ sha, force = false }) {        // P3 ALWAYS passes force:false
      try { const r = await api('PATCH', `/git/refs/heads/${enc(branch)}`, { sha, force }); return r.object.sha; }
      catch (e) { if (e.status === 422) throw new ConflictError('Remote moved (non-fast-forward).', e.body); throw e; }
    },
    async createRef({ sha }) {                       // first commit on an empty repo
      try { const r = await api('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha }); return r.object.sha; }
      catch (e) { if (e.status === 422) throw new ConflictError('Ref already exists (repo initialized concurrently).', e.body); throw e; }
    },
  };
}

export function b64ToBytes(b64) {
  const s = atob(String(b64).replace(/\s+/g, ''));
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
