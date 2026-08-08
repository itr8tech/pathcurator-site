// src/ui/views/audit.js — #/audit: every flagged link across all workspaces, in one place, with a
// manual status override at two strengths. "Good" = soft verify (trusted ~90 days, then the auditor
// re-checks it); "Pin" = hard opt-out (always good, never re-checked); "Broken" flags a known-dead
// link; "Auto" hands it back to the auditor now. Soft overrides EXPIRE so a link that dies later is
// eventually re-flagged; pinned ones never do (mergeAuditResults enforces both). Overrides commit to
// audit/overrides.json, so they travel between devices and the audit workflow skips them.
import { el, clear, ttButton as ttButtonBase } from '../dom.js';
import { confirmDelete } from '../editors.js';
import { onExtension, extensionInfo, runExtensionAudit } from '../ext-bridge.js';
import { toast } from '../toast.js';

function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 3600000) return `${Math.max(1, Math.floor(d / 60000))}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  if (d < 30 * 86400000) return `${Math.floor(d / 86400000)}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}
function category(b) {
  if (b.check_method === 'manual' || b.check_method === 'pinned') return b.available === 1 ? 'verified' : 'broken';
  if (b.requires_auth || b.status_label === 'Auth required') return 'auth';
  if (b.available === 0 && (b.status_label === 'Timeout' || b.status_label === 'Blocked'))
    // A CI timeout may be an on-network false positive; a timeout from YOUR OWN browser is the
    // opposite — a strong broken signal. Different sections, different honesty.
    return b.check_method === 'extension' ? 'unreachable-ext' : 'unreachable';
  if (b.available === 0) return 'broken';
  if (b.redirect_url) return 'redirect';
  return 'other';
}
const SECTIONS = [
  ['broken', '🔴 Broken'],
  ['unreachable-ext', '🚫 Unreachable from your browser (extension check — likely really broken)'],
  ['auth', '🔑 Auth required (login-walled — usually fine)'],
  ['redirect', '↪️ Redirected'],
  ['unreachable', '⚠️ Couldn’t verify from CI (timeout / blocked — may be fine on-network)'],
  ['verified', '✅ Verified good (you marked these)'],
];
// A short human note on the override's lifetime, shown in the row meta.
function overrideNote(b) {
  if (b.override === 'pinned') return 'pinned · never re-checked';
  if (b.override === 'soft') return b.days_left > 0 ? `re-checks in ${b.days_left}d` : 'expired · re-scans next audit';
  return '';
}
// MODULE-scope extension-audit run state: every chunk merge fires a change event that re-renders
// this whole view, which used to wipe the "checked N of M…" status and re-enable the button
// mid-run. State living here survives re-renders (and remounts), so the section always shows the
// truth: running → progress text + disabled button.
const runningAudits = new Map();   // key (wsId | 'local') → { done, total }
const lastAuditRuns = new Map();   // key → { at, total, summary, needsPermission, failedChunks, lastError }

// The human conclusion of a run — issues first, and an explicit all-clear when there are none.
function runSummaryText(r) {
  if (r.needsPermission) return `${r.needsPermission} of ${r.total} links couldn’t be checked — turn on “Enable link auditing” in the extension’s toolbar popup, then run again.`;
  const s = r.summary || {};
  const parts = [];
  if (s.broken) parts.push(`${s.broken} broken`);
  if (s.unreachable) parts.push(`${s.unreachable} unreachable`);
  if (s.redirected) parts.push(`${s.redirected} redirected`);
  if (s.auth) parts.push(`${s.auth} behind a login`);
  const tail = r.failedChunks ? ` (${r.failedChunks} batch${r.failedChunks === 1 ? '' : 'es'} failed: ${r.lastError})` : '';
  return parts.length
    ? `${r.total} checked — ${parts.join(', ')} · ${s.ok} OK. Details in the sections below.${tail}`
    : `All ${r.total} links look good ✓${tail}`;
}

// Instant, focus-friendly tooltips (title= takes ~1s to appear and never shows on focus).
const ACTIONS = [
  ['good', '✓ Good', 'Verified good: trust this link for 90 days, then the auditor re-checks it automatically. Use for false positives you’re fairly sure about.'],
  ['pin', '📌 Pin good', 'Pin as good: never audit this link again. Use when you’re certain it’s fine and don’t want it re-checked — press Auto to undo.'],
  ['broken', '✗ Broken', 'Mark broken: flag this link as dead even if the checker passed it (e.g. a “page not found” that still returns 200).'],
  ['auto', '↺ Auto', 'Back to automatic: clear your override now and let the next audit decide this link’s status.'],
];

export default async function mount(container, params, ctx) {
  const root = el('div', { class: 'view-content audit-view' });
  container.append(root);
  let extSeen = !!extensionInfo();
  const offExt = onExtension(() => { if (!extSeen) { extSeen = true; refresh(); } });
  const controller = { title: 'Link audit', refresh, destroy() { offExt(); } };
  const openState = {};   // section key → open? — survives refresh() re-renders after each action
  const act = async (fn) => { try { await fn(); } catch (e) { ctx.announce(e.message || 'Action failed.', { assertive: true }); } };

  const ttButton = (label, tip, fn) =>
    ttButtonBase(label, tip, { class: 'btn btn--sm', 'data-requires-primary': true }, fn);

  function extLink(href, text) {
    return el('a', { class: 'audit-row__url', href, target: '_blank', rel: 'noopener noreferrer nofollow ugc' }, text);
  }

  function row(b, primary) {
    const safe = ctx.md.safeUrl(b.url);
    const safeRedirect = b.redirect_url ? ctx.md.safeUrl(b.redirect_url) : null;
    const status = `${b.http_status ? b.http_status + ' ' : ''}${b.status_label || (b.available === 0 ? 'Broken' : 'OK')}`;
    const li = el('li', { class: 'audit-row', 'data-id': b.id, 'data-focus-key': `audit:${b.id}` },
      el('div', { class: 'audit-row__head' }, el('strong', {}, b.title || b.url)),
      // The URL itself, visible and clickable — you can't judge a redirect (or recognise a false
      // positive) without seeing the address.
      safe ? extLink(safe, b.url) : el('span', { class: 'audit-row__url blocked' }, `${b.url} (link blocked — unsafe scheme)`),
      safeRedirect ? el('div', { class: 'audit-row__redirect' }, '↪ now redirects to ', extLink(safeRedirect, b.redirect_url)) : null,
      el('div', { class: 'audit-row__meta muted' },
        el('a', { href: `#/pathway/${encodeURIComponent(b.pathway_id)}` }, b.pathway_name),
        ` · ${b.workspace || 'local'} · ${status}${b.override ? ` · ${overrideNote(b)}` : (b.check_method ? ` · ${b.check_method}` : '')} · ${relTime(b.last_checked)}`));
    if (primary) {
      const rm = ttButton('🗑 Remove', 'Remove this link from its pathway — deletes the bookmark. Arrives as an uncommitted change you can review before committing.',
        (e) => confirmDelete({ noun: 'bookmark', name: b.title || b.url, invoker: e.currentTarget,
          onConfirm: () => ctx.db.deleteBookmark({ id: b.id }) }));
      rm.querySelector('button').classList.add('btn--danger');
      li.append(el('div', { class: 'audit-row__actions' },
        ACTIONS.map(([status2, label, tip]) => ttButton(label, tip, () => act(() => ctx.db.setBookmarkAuditStatus({ id: b.id, status: status2 })))),
        rm));
    }
    return li;
  }

  function section(key, label, items, primary) {
    const sum = el('summary', { class: 'audit-section__summary' },
      el('h2', { class: 'audit-section__title' }, `${label} (${items.length})`));
    const list = el('ul', { class: 'audit-list', role: 'list' });
    for (const b of items) list.append(row(b, primary));
    const d = el('details', { class: 'audit-section', open: openState[key] === true }, sum, list);   // collapsed by default
    d.addEventListener('toggle', () => { openState[key] = d.open; });
    return d;
  }

  const setAll = (open) => {
    for (const d of root.querySelectorAll('details.audit-section')) d.open = open;   // toggle handlers record openState
  };

  // Install/update the GitHub Action tooling into each connected repo. Status is PROBED from the
  // repo (async, after paint), so it survives re-renders and is truthful across devices: not
  // installed → installed-waiting-on-first-run → active (results committed).
  const statusText = (s) => !s.workflow && !s.scripts ? 'not installed'
    : s.workflow && s.current === false ? (s.hasResults ? 'active — update available' : 'installed — update available')
    : s.workflow && s.hasResults ? 'active ✓ — checks all links weekly (Mondays 06:17 UTC)'
    : s.workflow ? 'installed — waiting for the first audit run'
    : 'scripts only — workflow file missing (the token needs the “Workflows” permission)';
  // The last committed scan, summarized like the extension card: when, how many, what was found,
  // and whether this device has merged those results yet.
  function wfRunText(lr) {
    if (!lr) return null;
    const parts = [];
    if (lr.broken) parts.push(`${lr.broken} broken`);
    if (lr.unreachable) parts.push(`${lr.unreachable} unreachable`);
    if (lr.redirected) parts.push(`${lr.redirected} redirected`);
    if (lr.auth) parts.push(`${lr.auth} behind a login`);
    const when = lr.generatedAt ? `Last scan ${relTime(lr.generatedAt)}` : 'Last scan';
    const found = lr.total === 0 ? 'no links audited yet'
      : `${lr.total} links checked — ${parts.length ? parts.join(', ') : 'no issues found ✓'}`;
    return `${when} · ${found} · ${lr.merged ? 'merged into the app ✓' : 'new results arrive on your next pull'}`;
  }
  // The button earns its place only when there is something to do: not installed, scripts-only,
  // or the committed copies drifted behind the app's ("Update"). Fully installed + current → no button.
  const needsButton = (s) => !s.workflow || !s.scripts || s.current === false;
  async function renderWorkflowSection() {
    const workspaces = (await ctx.db.getWorkspaces()).filter((w) => w.owner && w.repo);
    if (!workspaces.length) return null;
    const sec = el('section', { class: 'exempt-section', 'aria-labelledby': 'auditwf-h' });
    sec.append(el('h2', { id: 'auditwf-h' }, 'Audit workflow'),
      el('p', { class: 'muted' }, 'The GitHub Action that checks every link weekly and commits audit/results.json for the app to merge on pull. “Install / update” commits the checker scripts + workflow into the repository and starts the first run (idempotent — re-run it after app updates to refresh them).'));
    const list = el('ul', { class: 'exempt-list', role: 'list' });
    for (const w of workspaces) {
      const status = el('span', { class: 'muted', role: 'status' }, 'checking…');
      const runline = el('p', { class: 'muted wf-runline', hidden: true });
      const install = el('button', { type: 'button', class: 'btn btn--sm', 'data-requires-primary': true, 'data-audit-install': w.id, style: 'margin-inline-start:auto', hidden: true }, 'Install / update');
      const probe = () => ctx.sync.auditToolingStatus(w.id)
        .then((s) => {
          status.textContent = statusText(s);
          install.hidden = !needsButton(s);
          install.textContent = s.current === false ? 'Update' : 'Install / update';
          const t = wfRunText(s.lastRun);
          runline.hidden = !t;
          runline.textContent = t || '';
        })
        .catch(() => { status.textContent = 'status unavailable'; install.hidden = false; });
      install.addEventListener('click', async () => {
        install.disabled = true; status.textContent = 'installing…';
        try {
          const r = await ctx.sync.installAuditTooling(w.id);
          status.textContent = r.workflowSkipped
            ? 'scripts installed — the token can’t write workflow files; grant it the “Workflows” permission and re-run, or add .github/workflows/audit.yml by hand'
            : r.dispatched ? 'installed — first audit run started; results arrive on a future pull ✓'
            : 'installed — couldn’t start the run (token may need “Actions” permission); trigger it from the repo’s Actions tab';
          if (!r.workflowSkipped) install.hidden = true;   // done — the probe on the next render agrees
        } catch (e) { status.textContent = e.message || 'Could not install.'; }
        finally { install.disabled = false; }
      });
      probe();                                             // async fill-in; render doesn't block on it
      list.append(el('li', { class: 'wf-item' },
        el('div', { class: 'wf-item__head' }, el('code', {}, `${w.owner}/${w.repo}`), el('span', { class: 'muted' }, ` — ${w.org_label} `), install, status),
        runline));
    }
    sec.append(list);
    return sec;
  }

  // P8: live audit via the browser extension — a PROMINENT card at the top of the view (progress
  // bar + persistent per-workspace conclusions). ALL workspaces (connected or not — repo-less
  // curators are the audience) + a bucket for workspace-less pathways. Results are device-local
  // (the committed results.json stays Action-owned).
  async function renderExtensionSection() {
    if (!extensionInfo()) return null;
    const workspaces = await ctx.db.getWorkspaces();
    const targets = workspaces.map((w) => ({ id: w.id, label: w.org_label }));
    const localCount = (await ctx.db.listAuditUrls(null)).length;
    if (localCount) targets.push({ id: null, label: 'Local pathways (no workspace)' });
    if (!targets.length) return null;
    const sec = el('section', { class: 'ext-audit', 'aria-labelledby': 'extaudit-h' });
    sec.append(el('h2', { id: 'extaudit-h' }, 'Browser-extension audit'),
      el('p', { class: 'muted' }, 'Checks every link from this browser — including intranet links CI can’t reach. Results apply on this device; exempted and pinned links are skipped.'));
    for (const t of targets) {
      const key = t.id ?? 'local';
      const running = runningAudits.get(key);
      const last = lastAuditRuns.get(key);
      const fill = el('div', { class: 'ext-audit__fill' });
      const bar = el('div', { class: 'ext-audit__bar', role: 'progressbar', 'aria-label': `Audit progress for ${t.label}`, 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill);
      const status = el('span', { class: 'muted ext-audit__status', role: 'status' });
      const setProgress = (done, total) => {
        bar.hidden = false;
        const pct = total ? Math.round((done / total) * 100) : 0;
        fill.style.width = `${pct}%`;
        bar.setAttribute('aria-valuenow', String(pct));
        status.textContent = `checking ${done} of ${total}…`;
      };
      if (running) setProgress(running.done, running.total); else bar.hidden = true;
      const summaryLine = el('p', { class: 'ext-audit__summary' },
        running ? '' : last ? runSummaryText(last) : el('span', { class: 'muted' }, 'Not checked yet in this session.'));
      const run = el('button', { type: 'button', class: 'btn', 'data-requires-primary': true, 'data-ext-audit': key }, running ? 'Auditing…' : '🔎 Audit now');
      run.disabled = !!running;
      run.addEventListener('click', async () => {
        if (runningAudits.has(key)) return;
        runningAudits.set(key, { done: 0, total: 0 });
        run.disabled = true; run.textContent = 'Auditing…';
        setProgress(0, 0); status.textContent = 'starting…'; summaryLine.textContent = '';
        try {
          const r = await runExtensionAudit(ctx.db, t.id, (done, total) => {
            runningAudits.set(key, { done, total });
            if (bar.isConnected) setProgress(done, total);
          });
          lastAuditRuns.set(key, { at: Date.now(), ...r });
          toast(`${t.label}: ${runSummaryText(r)}`, { duration: r.needsPermission ? 9000 : 6000 });
        } catch (e) { toast(e.message || 'Audit failed.'); }
        finally {
          runningAudits.delete(key);
          refresh();                                 // re-render lands the persistent conclusion
        }
      });
      sec.append(el('div', { class: 'ext-audit__row' },
        el('div', { class: 'ext-audit__head' }, el('strong', {}, t.label), run),
        bar, status, summaryLine));
    }
    return sec;
  }

  // Link-audit exemptions: domains the auditor skips. Global; committed (audit/config.json) so the
  // Action honours them. Lives HERE with the rest of the audit tooling, not on #/sync.
  async function renderExemptSection() {
    const exempt = await ctx.db.listExemptDomains();
    const sec = el('section', { class: 'exempt-section', 'aria-labelledby': 'exempt-h' });
    sec.append(el('h2', { id: 'exempt-h' }, 'Link-audit exemptions'),
      el('p', { class: 'muted' }, 'Domains the link auditor skips — paywalled or auth-walled sites. Committed to the repo so the audit workflow honours them.'));
    const list = el('ul', { class: 'exempt-list', role: 'list' });
    if (!exempt.length) list.append(el('li', { class: 'muted' }, 'No exemptions yet.'));
    for (const e of exempt) {
      const rm = el('button', { type: 'button', class: 'btn btn--sm btn--danger', 'data-requires-primary': true, style: 'margin-inline-start:auto' }, 'Remove');
      rm.addEventListener('click', () => act(() => ctx.db.removeExemptDomain({ domain: e.domain })));
      list.append(el('li', {}, el('code', {}, e.domain), e.reason ? el('span', { class: 'muted' }, ` — ${e.reason}`) : '', rm));
    }
    const input = el('input', { type: 'text', name: 'domain', placeholder: 'example.com', 'aria-label': 'Domain to exempt', autocomplete: 'off' });
    const err = el('span', { class: 'field-error', role: 'alert' });
    const form = el('form', { class: 'exempt-add' }, input,
      el('button', { type: 'submit', class: 'btn btn--sm', 'data-requires-primary': true }, 'Add exemption'), err);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = '';
      try { await ctx.db.addExemptDomain({ domain: input.value }); input.value = ''; }
      catch (ex) { err.textContent = ex.message || 'Could not add.'; }
    });
    sec.append(list, form);
    return sec;
  }

  // BUILD-THEN-SWAP with a sequence guard: this view refreshes from several triggers (mount,
  // db change events, the extension announcing itself) and the body awaits between DOM writes —
  // two interleaved refreshes were double-appending sections. Build everything off-DOM first;
  // only the newest refresh gets to swap it in.
  let renderSeq = 0;
  async function refresh() {
    const seq = ++renderSeq;
    const flagged = await ctx.db.listFlaggedBookmarks();
    const primary = ctx.isPrimary();
    const kids = [
      el('h1', { 'data-view-heading': true, tabindex: -1 }, 'Link audit'),
      el('p', { class: 'muted audit-intro' }, 'Flagged links across all workspaces. “Good” trusts a false positive for ~90 days then lets the auditor re-check it; “Pin good” trusts it forever; “Broken” flags a known-dead link; “Auto” hands it back to the auditor now. Overrides are committed to the repo (audit/overrides.json) with your next commit, so they apply on every device and the audit workflow skips those links.'),
    ];
    // The live-check card sits at the TOP — it's the action, not an appendix.
    if (primary) {
      const ext = await renderExtensionSection();
      if (ext) kids.push(ext);
    }

    if (!flagged.length) {
      kids.push(el('p', { class: 'muted' }, 'No flagged links. Run the audit workflow (or pull) to populate statuses, then any problems show up here.'));
    } else {
      const expand = el('button', { type: 'button', class: 'btn btn--sm' }, 'Expand all');
      const collapse = el('button', { type: 'button', class: 'btn btn--sm' }, 'Collapse all');
      expand.addEventListener('click', () => setAll(true));
      collapse.addEventListener('click', () => setAll(false));
      kids.push(el('div', { class: 'audit-controls' }, expand, collapse));
      const byCat = {};
      for (const b of flagged) (byCat[category(b)] ||= []).push(b);
      for (const [key, label] of SECTIONS) {
        const items = byCat[key];
        if (items?.length) kids.push(section(key, label, items, primary));
      }
    }
    if (primary) {
      const wf = await renderWorkflowSection();
      if (wf) kids.push(wf);
      kids.push(await renderExemptSection());
    }

    if (seq !== renderSeq) return;                 // superseded by a newer refresh — discard
    // Section headers stick just below the (sticky) app header — measure it rather than guess.
    root.style.setProperty('--sticky-top', `${document.querySelector('.app-header')?.offsetHeight || 56}px`);
    clear(root);
    root.append(...kids);
  }

  await refresh();
  return controller;
}
