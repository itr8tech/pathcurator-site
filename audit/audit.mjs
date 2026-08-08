#!/usr/bin/env node
// audit/audit.mjs — PathCurator link auditor (the GitHub-Action checker, P5). Reads each workspace's
// committed pathway files, checks every URL SERVER-SIDE (real HTTP status — no browser CSP), and
// writes <root>/audit/results.json (machine-readable, merged by the app) + <root>/audit/REPORT.md
// (human-readable) + a summary on the Action run page. Node ≥ 20, built-ins only.
import { readFile, writeFile, appendFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_PARALLEL = 10;      // distinct hosts checked concurrently
const HOST_DELAY = 300;        // ms between requests to the SAME host (politeness → less throttling)
const DEFAULT_TIMEOUT = 12000;
const RETRIES = 1;             // retry transient failures (timeout / connection reset / 429) once
const RETRY_DELAY = 1500;
const UA = 'PathCurator-audit (+https://github.com/itr8tech/pathcurator-app)';
const IGNORE_DIRS = new Set(['.git', 'node_modules', '.github']);
// Curator overrides (audit/overrides.json, committed by the app): a soft 'manual' override is
// trusted this long from setAt, then checking resumes; 'pinned' is never checked. MUST match the
// app's AUDIT_MANUAL_TTL_MS (db-worker.js).
const MANUAL_TTL_MS = 90 * 24 * 60 * 60 * 1000;
// HEAD-hostile statuses: many hosts reject/blackhole HEAD but answer GET, so retry these with GET.
const HEAD_RETRY = new Set([400, 403, 405, 406, 501]);

export const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
export const exemptMatch = (host, exempt) => !!host && exempt.some((d) => host === d || host.endsWith('.' + d));

// HTTP status → the (honest) status the app stores. Never fakes a 200.
export function classify(status) {
  if (status >= 200 && status < 300) return { available: 1, statusLabel: 'OK', requiresAuth: 0 };
  if (status >= 300 && status < 400) return { available: 1, statusLabel: 'Redirected', requiresAuth: 0 };
  if (status === 401 || status === 403) return { available: 0, statusLabel: 'Auth required', requiresAuth: 1 };
  if (status === 404 || status === 410) return { available: 0, statusLabel: 'Not found', requiresAuth: 0 };
  if (status >= 500) return { available: 0, statusLabel: 'Server error', requiresAuth: 0 };
  return { available: 0, statusLabel: 'Blocked', requiresAuth: 0 };
}

async function findManifests(dir, out = []) {
  for (const name of await readdir(dir)) {
    if (IGNORE_DIRS.has(name)) continue;
    const p = join(dir, name);
    const s = await stat(p);
    if (s.isDirectory()) await findManifests(p, out);
    else if (name === 'manifest.json') out.push(p);
  }
  return out;
}

async function tryFetch(url, method, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': UA } });
    return { status: res.status, redirected: res.redirected, finalUrl: res.url, failed: false, timedOut: false };
  } catch (e) {
    return { failed: true, timedOut: e?.name === 'AbortError', error: String(e?.message || e) };
  } finally { clearTimeout(timer); }
}

// HEAD first (cheap); if it times out, errors, or returns a HEAD-hostile status, retry with GET and
// prefer that authoritative answer. Fixes false "Timeout"s from hosts that just hang on HEAD.
async function check(url, timeoutMs) {
  const started = Date.now();
  let r = await tryFetch(url, 'HEAD', timeoutMs);
  if (r.failed || HEAD_RETRY.has(r.status)) {
    const g = await tryFetch(url, 'GET', timeoutMs);
    if (!g.failed) r = g;                 // GET succeeded → authoritative
    else if (r.failed) r = g;             // both failed → report GET's failure
    // else: GET failed but HEAD had a real status → keep HEAD
  }
  const durationMs = Date.now() - started;
  if (r.failed) {
    return { available: 0, httpStatus: null, statusLabel: r.timedOut ? 'Timeout' : 'Blocked', redirectUrl: null,
      requiresAuth: 0, checkError: (r.error || '').slice(0, 200), checkedAt: Date.now(), durationMs };
  }
  const c = classify(r.status);
  return { available: c.available, httpStatus: r.status, statusLabel: c.statusLabel,
    redirectUrl: r.redirected && r.finalUrl && r.finalUrl !== url ? r.finalUrl : null, requiresAuth: c.requiresAuth,
    checkError: null, checkedAt: Date.now(), durationMs };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Retry-worthy failures: a timeout, a 429 rate-limit, or a network error (fetch failed) — the kinds
// throttling produces. A real 4xx/5xx is NOT retried (it's a stable answer).
const isTransient = (r) => r.statusLabel === 'Timeout' || r.httpStatus === 429 || (r.available === 0 && !!r.checkError && r.statusLabel === 'Blocked');

async function checkWithRetry(url, timeoutMs) {
  let r = await check(url, timeoutMs);
  for (let attempt = 0; attempt < RETRIES && isTransient(r); attempt++) {
    await sleep(RETRY_DELAY * (attempt + 1));
    r = await check(url, timeoutMs + 5000);   // give a slow/throttled host more room on retry
  }
  return r;
}

// Per-host politeness: group URLs by host and check them ONE-AT-A-TIME per host with a small gap,
// while up to HOST_PARALLEL hosts run concurrently. A burst of parallel requests to a single host
// (e.g. www2.gov.bc.ca) is what triggers rate-limiting / false timeouts — this avoids the burst.
async function politePool(entries, timeoutMs) {
  const byHost = new Map();
  for (const e of entries) { const h = hostOf(e[1]) || e[0]; if (!byHost.has(h)) byHost.set(h, []); byHost.get(h).push(e); }
  const hosts = [...byHost.keys()]; let hi = 0;
  const results = new Map();
  await Promise.all(Array.from({ length: Math.min(HOST_PARALLEL, hosts.length) }, async () => {
    while (hi < hosts.length) {
      const urls = byHost.get(hosts[hi++]);
      for (let i = 0; i < urls.length; i++) {
        results.set(urls[i][0], await checkWithRetry(urls[i][1], timeoutMs));
        if (i < urls.length - 1) await sleep(HOST_DELAY);
      }
    }
  }));
  return results;
}

// ---- human-readable report (committed REPORT.md + the Action run-page summary) ----
const cell = (s) => String(s ?? '').replace(/\s+/g, ' ').replace(/[|\[\]]/g, '').trim();
const statusText = (x) => `${x.httpStatus ?? '—'} ${x.statusLabel}`;

export function buildReport(label, rows, skipped = []) {
  const counts = {};
  for (const x of rows) counts[x.statusLabel] = (counts[x.statusLabel] || 0) + 1;
  const order = ['OK', 'Redirected', 'Auth required', 'Not found', 'Server error', 'Blocked', 'Timeout'];
  const summary = order.filter((k) => counts[k]).map((k) => `${counts[k]} ${k}`).join(' · ');
  const L = [`# Link audit — ${label}`, '',
    `**${rows.length} links checked**${skipped.length ? ` · ${skipped.length} curator-overridden (skipped)` : ''} · ${summary || 'none'}`, ''];
  const section = (title, items, redir = false) => {
    if (!items.length) return;
    L.push(`## ${title} (${items.length})`, '', `| Pathway | Link | ${redir ? 'Redirects to' : 'Status'} |`, '| --- | --- | --- |');
    for (const x of items) L.push(`| ${cell(x.pathway)} | [${cell(x.title)}](${x.url}) | ${redir ? `\`${cell(x.redirectUrl)}\`` : statusText(x)} |`);
    L.push('');
  };
  // "Broken" = only genuinely dead links (404/410/5xx) — STABLE, actionable. Network errors / 429 /
  // timeouts are transient (esp. from a CI datacenter IP) and go in a separate "couldn't verify"
  // bucket, so a flaky run never reports them as broken.
  const DEAD = new Set(['Not found', 'Server error']);
  const broken = rows.filter((x) => DEAD.has(x.statusLabel));
  section('🔴 Broken', broken);
  section('🔑 Auth required (login-walled — expected)', rows.filter((x) => x.statusLabel === 'Auth required'));
  section('↪️ Redirected', rows.filter((x) => x.statusLabel === 'Redirected'), true);
  section('⚠️ Couldn’t verify from CI (timeout / blocked — may be fine on-network)', rows.filter((x) => x.statusLabel === 'Timeout' || x.statusLabel === 'Blocked'));
  // Curator overrides — never fetched. Shown for transparency: pinned links stay silent forever,
  // soft "verified good" ones re-enter the check rotation after their TTL. Curator-flagged-broken
  // links are known to the curator already, so they don't feed the notification.
  const expiry = (x) => x.method === 'pinned' ? 'pinned — never re-checked' : `re-checks after ${new Date((Number(x.setAt) || 0) + MANUAL_TTL_MS).toISOString().slice(0, 10)}`;
  const ovSection = (title, items) => {
    if (!items.length) return;
    L.push(`## ${title} (${items.length})`, '', '| Pathway | Link | Note |', '| --- | --- | --- |');
    for (const x of items) L.push(`| ${cell(x.pathway)} | [${cell(x.title)}](${x.url}) | ${expiry(x)} |`);
    L.push('');
  };
  ovSection('🚫 Curator-flagged broken (marked in the app — not checked)', skipped.filter((x) => !x.available));
  ovSection('📌 Curator-verified good (not checked)', skipped.filter((x) => x.available));
  if (!broken.length && !skipped.some((x) => !x.available)) L.push('No dead links. ✅', '');
  return L.join('\n') + '\n';
}

async function auditRoot(manifestPath) {
  const root = dirname(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
  let config = { exemptDomains: [], timeoutMs: DEFAULT_TIMEOUT };
  try { config = { ...config, ...JSON.parse(await readFile(join(root, 'audit', 'config.json'), 'utf-8')) }; } catch { /* first run: no config yet */ }
  const exempt = (config.exemptDomains || []).map((d) => String(d).toLowerCase());
  const timeoutMs = Number(config.timeoutMs) || DEFAULT_TIMEOUT;
  // Curator overrides: pinned → never check; manual within TTL → trust for now; expired → check.
  let ovMap = {};
  try { ovMap = JSON.parse(await readFile(join(root, 'audit', 'overrides.json'), 'utf-8')).overrides || {}; } catch { /* none committed */ }
  const activeOverride = (norm) => {
    const e = ovMap[norm];
    if (!e) return null;
    if (e.method === 'pinned') return e;
    if (e.method === 'manual' && Date.now() - Number(e.setAt) < MANUAL_TTL_MS) return e;
    return null;
  };

  const meta = new Map();   // url_norm → { url, title, pathway } (first occurrence), deduped, exempt-skipped
  for (const entry of manifest.pathways || []) {
    let pw; try { pw = JSON.parse(await readFile(join(root, entry.file), 'utf-8')); } catch { continue; }
    const pathway = pw.pathway?.name || entry.name || entry.id;
    for (const s of pw.pathway?.steps || []) for (const b of s.bookmarks || []) {
      const norm = b.url_norm || b.url;
      if (!norm || meta.has(norm) || exemptMatch(hostOf(b.url), exempt)) continue;
      meta.set(norm, { url: b.url, title: b.title || b.url, pathway });
    }
  }
  // Overridden URLs are SKIPPED (no request) and OMITTED from results.json — the app applies
  // overrides from audit/overrides.json itself, and the notifier only counts checker results.
  const items = [], skipped = [];
  for (const [norm, m] of meta) {
    const ov = activeOverride(norm);
    if (ov) skipped.push({ ...m, method: ov.method === 'pinned' ? 'pinned' : 'manual', available: ov.available ? 1 : 0, setAt: Number(ov.setAt) || 0 });
    else items.push([norm, m.url]);
  }
  const checked = await politePool(items, timeoutMs);   // Map(url_norm → result)

  const results = {};
  const rows = [];
  for (const norm of [...checked.keys()].sort()) {
    const r = checked.get(norm);
    results[norm] = r;
    rows.push({ ...meta.get(norm), ...r });
  }

  await mkdir(join(root, 'audit'), { recursive: true });
  await writeFile(join(root, 'audit', 'results.json'),
    JSON.stringify({ schemaVersion: 1, generatedAt: Date.now(), checkMethod: 'github-action', results }, null, 2) + '\n');
  const report = buildReport(relative(process.cwd(), root) || 'repo root', rows, skipped);
  await writeFile(join(root, 'audit', 'REPORT.md'), report);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report + '\n');
  console.log(`audited ${items.length} link(s) (${skipped.length} curator-overridden, skipped) under ${root || '.'}`);
}

// Run only when invoked directly (so tests can import the pure helpers).
if ((process.argv[1] && import.meta.url === `file://${process.argv[1]}`) || (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])) {
  const manifests = await findManifests(process.cwd());
  if (!manifests.length) { console.log('no manifest.json found — nothing to audit'); }
  else for (const m of manifests) await auditRoot(m);
}
