#!/usr/bin/env node
// audit/notify.mjs — opens/updates a GitHub Issue with the link-audit report when there are broken
// links, so GitHub emails repo watchers. Credential-free: uses the Action's built-in GITHUB_TOKEN +
// GITHUB_REPOSITORY (no SMTP, no secrets). To avoid weekly nagging it only COMMENTS (which triggers
// the email) when the set of broken links CHANGES; it closes the issue when everything is reachable
// again. "Broken" excludes Auth-required (login-walled, expected) and Timeout (verify-manually).
// Node built-ins only. Runs after audit.mjs in the workflow.
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const TOKEN = process.env.GITHUB_TOKEN, REPO = process.env.GITHUB_REPOSITORY;
if (!TOKEN || !REPO) { console.log('no GITHUB_TOKEN/REPOSITORY — skipping notify'); process.exit(0); }
const [OWNER, NAME] = REPO.split('/');
const MARKER = '<!-- pathcurator-audit -->';
const TITLE = '🔗 Link audit: broken links';

async function api(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method, headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} ${method} ${path}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}
async function walk(dir, out = []) {
  for (const n of await readdir(dir)) {
    if (['.git', 'node_modules', '.github'].includes(n)) continue;
    const p = join(dir, n), s = await stat(p);
    if (s.isDirectory()) await walk(p, out);
    else if (n === 'results.json' && dirname(p).endsWith('audit')) out.push(p);
  }
  return out;
}

let broken = [];
const reports = [];
for (const rp of await walk(process.cwd())) {
  const d = JSON.parse(await readFile(rp, 'utf-8'));
  // Only genuinely dead links (404/410/5xx) are "broken" — stable across runs. Timeout / Blocked /
  // 429 are transient (a CI datacenter IP gets throttled) and must NOT trigger an email.
  for (const [norm, r] of Object.entries(d.results || {}))
    if (r.statusLabel === 'Not found' || r.statusLabel === 'Server error') broken.push(norm);
  try { reports.push(await readFile(rp.replace(/results\.json$/, 'REPORT.md'), 'utf-8')); } catch { /* no report */ }
}
broken = [...new Set(broken)].sort();
const fp = createHash('sha1').update(broken.join('\n')).digest('hex').slice(0, 12);

const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
const body = `${MARKER}<!-- fp:${fp} -->\n_Automated by the PathCurator link-audit workflow${runUrl ? ` · [latest run](${runUrl})` : ''} · updated ${new Date().toISOString().slice(0, 10)}._\n\n${reports.join('\n\n---\n\n')}`;

const openIssues = await api('GET', `/repos/${OWNER}/${NAME}/issues?state=open&per_page=100`);
const existing = openIssues.find((i) => (i.body || '').includes(MARKER));

if (!broken.length) {
  if (existing) {
    await api('POST', `/repos/${OWNER}/${NAME}/issues/${existing.number}/comments`, { body: 'All previously-broken links are now reachable. ✅ Closing.' });
    await api('PATCH', `/repos/${OWNER}/${NAME}/issues/${existing.number}`, { state: 'closed' });
    console.log(`resolved — closed #${existing.number}`);
  } else console.log('no broken links, no open issue — nothing to do');
} else if (!existing) {
  const created = await api('POST', `/repos/${OWNER}/${NAME}/issues`, { title: `${TITLE} (${broken.length})`, body });
  console.log(`opened #${created.number} — ${broken.length} broken`);
} else {
  const changed = !(existing.body || '').includes(`fp:${fp}`);
  await api('PATCH', `/repos/${OWNER}/${NAME}/issues/${existing.number}`, { title: `${TITLE} (${broken.length})`, body });
  if (changed) {
    await api('POST', `/repos/${OWNER}/${NAME}/issues/${existing.number}/comments`, { body: `Broken-link set changed — now ${broken.length} broken.${runUrl ? ` [Report](${runUrl})` : ''}` });
    console.log(`updated #${existing.number} + commented (set changed)`);
  } else console.log(`updated #${existing.number} silently (set unchanged)`);
}
