// src/ui/views/pathway.js — detail: collapsible steps, arrow reorder, sanitized markdown,
// bookmark description + curator context, header image.
import { el, clear } from '../dom.js';
import { initReorder, reorderControls } from '../reorder.js';
import { openPathwayEditor, openStepEditor, openBookmarkEditor, confirmDelete } from '../editors.js';
import { makeObjectUrlScope } from '../attachments.js';

// Link-audit status (P5). status_label is untrusted → only render it if it's a known label.
const AUDIT_LABELS = new Set(['OK', 'Broken', 'Not found', 'Server error', 'Timeout', 'Redirected', 'Auth required', 'Blocked']);
const auditHost = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
function relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 3600000) return `${Math.max(1, Math.floor(diff / 60000))}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 30 * 86400000) return `${Math.floor(diff / 86400000)}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}

export default async function mount(container, params, ctx) {
  const root = el('div', { class: 'view-content' }); container.append(root);
  let teardownReorder = null, pathwayId = null, exemptDomains = [];
  const imgScope = makeObjectUrlScope();
  const collapsed = new Set();   // collapsed step ids — persists across re-renders
  const controller = { title: 'Pathway', refresh, destroy() { teardownReorder?.(); imgScope.dispose(); } };
  const primary = () => ctx.isPrimary();
  const md = (src) => el('div', { class: 'prose' }, ctx.md.renderMarkdown(src));
  const btn = (txt, props, fn) => { const b = el('button', { type: 'button', ...props }, txt); b.addEventListener('click', fn); return b; };

  // Link-audit pill from the bookmark's audit columns (most-specific first). Untrusted fields are
  // sanitized: status_label enum-clamped, redirect_url routed through safeUrl into the title only.
  function auditBadge(b) {
    const host = auditHost(b.url);
    if (host && exemptDomains.some((d) => host === d || host.endsWith('.' + d)))
      return el('span', { class: 'badge audit-badge audit--muted', title: `Skipped by exemption (${host})` }, 'Exempt');
    if (b.last_checked == null) return null;                    // unchecked → no pill (avoid noise pre-audit)
    const checked = `Checked ${relTime(b.last_checked)}`;
    const withStatus = (t) => (b.http_status ? `${t} · HTTP ${b.http_status}` : t);
    if (b.available === 0)
      return el('span', { class: 'badge audit-badge audit--danger', title: withStatus(checked) }, AUDIT_LABELS.has(b.status_label) ? b.status_label : 'Broken');
    if (b.requires_auth) return el('span', { class: 'badge audit-badge audit--info', title: checked }, 'Auth required');
    if (b.redirect_url) { const safe = ctx.md.safeUrl(b.redirect_url); return el('span', { class: 'badge audit-badge audit--info', title: safe ? `Redirects to ${safe}` : checked }, 'Redirects →'); }
    return el('span', { class: 'badge audit-badge audit--ok', title: withStatus(checked) }, 'OK');
  }

  // ---- collapse: one delegated listener on the persistent root ----
  const applyCollapsed = (li, on) => {
    const body = li.querySelector('.step__body'), toggle = li.querySelector('.step__toggle');
    li.classList.toggle('step--collapsed', on);
    if (body) body.hidden = on;
    if (toggle) toggle.setAttribute('aria-expanded', String(!on));
  };
  function updateCollapseAllBtn() {
    const b = root.querySelector('[data-collapse-all]'); if (!b) return;
    const steps = root.querySelectorAll('li.step');
    const allCollapsed = steps.length > 0 && collapsed.size >= steps.length;
    b.dataset.collapseAll = allCollapsed ? 'expand' : 'collapse';
    b.textContent = allCollapsed ? 'Expand all' : 'Collapse all';
    b.setAttribute('aria-label', allCollapsed ? 'Expand all steps' : 'Collapse all steps');
  }
  root.addEventListener('click', (e) => {
    const tog = e.target.closest('.step__toggle');
    if (tog) {
      const li = tog.closest('[data-id]'), id = li.dataset.id, on = !collapsed.has(id);
      on ? collapsed.add(id) : collapsed.delete(id); applyCollapsed(li, on); updateCollapseAllBtn(); return;
    }
    const all = e.target.closest('[data-collapse-all]');
    if (all) {
      const on = all.dataset.collapseAll === 'collapse';
      for (const li of root.querySelectorAll('li.step')) { on ? collapsed.add(li.dataset.id) : collapsed.delete(li.dataset.id); applyCollapsed(li, on); }
      updateCollapseAllBtn(); announceSteps(on);
    }
  });
  const announceSteps = (on) => ctx.announce(on ? 'All steps collapsed.' : 'All steps expanded.');

  async function refresh() {
    const [p, exempt] = await Promise.all([ctx.db.getPathway(params.id), ctx.db.listExemptDomains()]);
    exemptDomains = exempt.map((e) => e.domain);
    pathwayId = p?.id ?? null;
    const pws = p?.workspace_id ? await ctx.db.getWorkspace(p.workspace_id).catch(() => null) : null;
    teardownReorder?.(); imgScope.dispose(); clear(root);
    if (!p) {
      root.append(el('h1', { 'data-view-heading': true, tabindex: -1 }, 'Pathway not found'),
        el('p', {}, el('a', { href: '#/' }, 'Back to dashboard')));
      return;
    }
    controller.title = p.name;
    if (p.header_image_id) { const url = await imgScope.url(p.header_image_id); if (url) root.append(el('img', { class: 'header-image', src: url, alt: '' })); }
    root.append(el('h1', { 'data-view-heading': true, tabindex: -1 }, p.name));
    if (p.content_warning) root.append(el('div', { class: 'content-warning', role: 'note' }, el('span', { class: 'callout-label' }, 'Content warning'), md(p.content_warning)));
    if (p.description) root.append(md(p.description));

    root.append(el('div', { class: 'row' },
      btn('Edit pathway', { class: 'btn', 'data-requires-primary': true, 'data-focus-key': `edit-pathway:${p.id}` },
        (ev) => openPathwayEditor({ pathway: p, invoker: ev.currentTarget, ctx })),
      btn('Delete pathway', { class: 'btn btn--danger', 'data-requires-primary': true, 'data-focus-key': `del-pathway:${p.id}` },
        (ev) => confirmDelete({ noun: 'pathway', name: p.name, invoker: ev.currentTarget,
          onConfirm: async () => { await ctx.db.deletePathway({ id: p.id }); ctx.navigate('#/'); } })),
      btn('+ Step', { class: 'btn', 'data-requires-primary': true, 'data-focus-key': `add-step:${p.id}` },
        (ev) => openStepEditor({ pathwayId: p.id, invoker: ev.currentTarget, ctx })),
      // P6/P7 exports (all formats in one dialog): read-shaped → usable from a follower tab too
      btn('⬇ Export…', { class: 'btn', 'data-focus-key': `export-pathway:${p.id}`,
        title: 'Export as a data file, interactive web page, spreadsheet, feed, or browser bookmarks' },
        (ev) => openExportDialog({ pathway: p, invoker: ev.currentTarget, ctx })),
      // P10 1b: repo-published SCORM package (Moodle auto-update) — connected workspaces only
      pws?.owner && pws?.repo
        ? btn('🌐 Publish…', { class: 'btn', 'data-focus-key': `publish-pathway:${p.id}`, 'data-publish-open': p.id,
          title: 'Keep a SCORM package published in the repository — Moodle activities pointed at its URL update automatically' },
          (ev) => openPublishDialog({ pathway: p, ws: pws, invoker: ev.currentTarget, ctx }))
        : null));

    if (p.steps.length) root.append(el('div', { class: 'steps-toolbar' },
      el('button', { type: 'button', class: 'btn btn--subtle', 'data-collapse-all': 'collapse' }, 'Collapse all')));

    const stepsList = el('ol', { class: 'steps', 'data-reorder-scope': 'step', role: 'list' });
    p.steps.forEach((s, i) => stepsList.append(renderStep(s, i, p.steps.length)));
    root.append(stepsList);

    teardownReorder = initReorder(root, ctx);
    updateCollapseAllBtn();
    if (!primary()) for (const c of root.querySelectorAll('[data-requires-primary]')) {
      if ('disabled' in c && c.tagName !== 'A') c.disabled = true; else { c.setAttribute('aria-disabled', 'true'); c.tabIndex = -1; }
    }
  }

  function renderStep(s, i, total) {
    const on = collapsed.has(s.id), bodyId = `sb-${s.id}`, n = s.bookmarks.length;
    const li = el('li', { class: 'step' + (on ? ' step--collapsed' : ''), 'data-id': s.id, 'data-focus-key': `step:${s.id}` });
    const toggle = el('button', { class: 'step__toggle', type: 'button', 'aria-expanded': String(!on), 'aria-controls': bodyId },
      el('span', { class: 'chevron', 'aria-hidden': 'true' }, '▸'),
      el('span', { class: 'step__num' }, String(i + 1)),
      el('span', { class: 'step__title' }, s.name),
      el('span', { class: 'step__meta muted' }, ` · ${n} ${n === 1 ? 'link' : 'links'}`));
    const header = el('div', { class: 'step__header' },
      el('h2', { class: 'step__name' }, toggle),
      el('span', { class: 'step__controls' },
        reorderControls({ entity: 'step', id: s.id, index: i, count: total, label: `step “${s.name}”` }),
        btn('✎', { class: 'btn btn--icon', 'data-requires-primary': true, 'aria-label': 'Edit step', 'data-focus-key': `edit-step:${s.id}` },
          (ev) => openStepEditor({ pathwayId, step: s, invoker: ev.currentTarget, ctx })),
        btn('🗑', { class: 'btn btn--icon btn--danger', 'data-requires-primary': true, 'aria-label': 'Delete step' },
          (ev) => confirmDelete({ noun: 'step', name: s.name, invoker: ev.currentTarget, onConfirm: () => ctx.db.deleteStep({ id: s.id }) }))));
    const body = el('div', { class: 'step__body', id: bodyId });
    if (on) body.hidden = true;
    if (s.objective) body.append(md(s.objective));
    // Required links first, bonus in their own subtly-distinct section. Reordering is scoped
    // per group (moveEntity places bookmarks within their required-group).
    const required = s.bookmarks.filter((b) => b.required);
    const bonus = s.bookmarks.filter((b) => !b.required);
    for (const [items, key, label] of [[required, 'required', 'Required'], [bonus, 'bonus', 'Bonus']]) {
      if (!items.length) continue;
      if (required.length && bonus.length) body.append(el('h3', { class: 'bm-group-label' }, label));
      const bl = el('ul', { class: `bookmarks bookmarks--${key}`, 'data-reorder-scope': 'bookmark', 'data-parent': s.id, role: 'list' });
      items.forEach((b, bi) => bl.append(renderBookmark(b, bi, items.length, s.id)));
      body.append(bl);
    }
    body.append(btn('+ Link', { class: 'btn', 'data-requires-primary': true, 'data-focus-key': `add-link:${s.id}` },
      (ev) => openBookmarkEditor({ stepId: s.id, invoker: ev.currentTarget, ctx })));
    if (s.pause_and_reflect) body.append(el('div', { class: 'pause-reflect' }, el('span', { class: 'callout-label' }, 'Pause & reflect'), md(s.pause_and_reflect)));
    li.append(header, body);
    return li;
  }

  function renderBookmark(b, i, total, stepId) {
    const li = el('li', { class: 'bookmark', 'data-id': b.id, 'data-focus-key': `bookmark:${b.id}` });
    li.append(el('div', { class: 'bookmark__head' },
      reorderControls({ entity: 'bookmark', id: b.id, index: i, count: total, label: `link “${b.title || b.url}”` }),
      el('a', { class: 'bookmark__title', href: b.url, target: '_blank', rel: 'noopener noreferrer nofollow ugc' }, b.title || b.url),
      el('span', { class: 'bookmark__badges' },
        el('span', { class: 'badge', 'data-type': b.content_type }, b.content_type),
        el('span', { class: b.required ? 'badge badge--required' : 'badge badge--bonus' }, b.required ? 'Required' : 'Bonus'),
        auditBadge(b))));
    if (b.description) li.append(el('div', { class: 'prose bookmark__desc' }, ctx.md.renderMarkdown(b.description)));
    if (b.context) li.append(el('div', { class: 'bookmark__context' },
      el('span', { class: 'callout-label' }, 'Curator context'), el('div', { class: 'prose' }, ctx.md.renderMarkdown(b.context))));
    li.append(el('div', { class: 'row bookmark__actions' },
      btn('Edit', { class: 'btn btn--icon', 'data-requires-primary': true, 'aria-label': 'Edit link', 'data-focus-key': `edit-bm:${b.id}` },
        (ev) => openBookmarkEditor({ stepId, bm: b, invoker: ev.currentTarget, ctx })),
      btn('Delete', { class: 'btn btn--icon btn--danger', 'data-requires-primary': true, 'aria-label': 'Delete link' },
        (ev) => confirmDelete({ noun: 'link', name: b.title || b.url, invoker: ev.currentTarget, onConfirm: () => ctx.db.deleteBookmark({ id: b.id }) }))));
    return li;
  }

  await refresh();
  return controller;
}

// P7: the one export dialog — five formats over the same canonical shape. Attribution (author
// name) is OFF by default, remembered as a setting, and applies to the publishing formats (web
// page / CSV / RSS); the JSON data file always carries full data by design. Richer attribution
// (bio, author link, several fields) is a recorded TODO for later.
const EXPORT_FORMATS = [   // [value, label, hint, group] — grouped now that there are six
  ['json', 'Data file (JSON)', 'full fidelity — for importing into PathCurator', 'Data'],
  ['html', 'Web page (HTML)', 'self-contained interactive page for learners, tracks launch progress', 'Learner page'],
  ['scorm', 'SCORM package (zip)', 'tracked activity for Moodle and other LMSs — completion + gradebook', 'LMS package'],
  ['moodle', 'Moodle starter course (.mbz)', 'one-time bootstrap: restore as a new course — single-activity, resource-style settings pre-configured', 'LMS package'],
  ['csv', 'Spreadsheet (CSV)', 'one row per link — opens in Excel/Sheets, re-importable', 'Feeds & files'],
  ['rss', 'Feed (RSS)', 'one item per link, for feed readers', 'Feeds & files'],
  ['bookmarks', 'Browser bookmarks (HTML)', 'import into any browser — a folder per step', 'Feeds & files'],
];
async function openExportDialog({ pathway: p, invoker, ctx }) {
  const { el } = await import('../dom.js');
  const saved = (await ctx.db.getSetting('publish_attribution')) === '1';
  const dlg = el('dialog', { class: 'pc-editor' });
  const cb = el('input', { type: 'checkbox', name: 'attribution', checked: saved });
  const err = el('p', { class: 'field-error', role: 'alert' });
  const submit = el('button', { type: 'submit', class: 'btn btn--primary' }, 'Export');
  let lastGroup = null;
  const radios = EXPORT_FORMATS.flatMap(([value, label, hint, group], i) => {
    const r = el('input', { type: 'radio', name: 'fmt', value, checked: i === 0 });
    const item = el('label', { class: 'export-fmt' }, r, el('span', {}, el('strong', {}, label), ' — ', el('span', { class: 'muted' }, hint)));
    const head = group !== lastGroup ? [el('p', { class: 'export-group', 'aria-hidden': 'true' }, group)] : [];
    lastGroup = group;
    return [...head, item];
  });
  const form = el('form', { novalidate: true, 'aria-labelledby': 'exp-h' },
    el('h2', { id: 'exp-h', 'data-view-heading': true, tabindex: -1 }, `Export — ${p.name}`),
    el('fieldset', { class: 'export-fmts' }, el('legend', {}, 'Format'), ...radios),
    el('label', { class: 'field-label', style: 'display:flex;gap:.5rem;align-items:center;font-weight:400' }, cb,
      ' Include author attribution (web page, SCORM, CSV and RSS)'),
    err,
    el('div', { class: 'form-actions' }, el('button', { type: 'button', class: 'btn' }, 'Cancel'), submit));
  form.querySelector('.form-actions .btn').addEventListener('click', () => dlg.close('cancel'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    submit.disabled = true; dlg.setAttribute('aria-busy', 'true');
    try {
      const fmt = form.querySelector('input[name="fmt"]:checked')?.value || 'json';
      const attribution = cb.checked;
      if (ctx.isPrimary()) await ctx.db.setSetting('publish_attribution', attribution ? '1' : '0').catch(() => {});
      const { downloadFile } = await import('../download.js');
      let out, mime = 'application/json';
      if (fmt === 'json') {
        const { buildExportFile } = await import('/src/data/exchange.js');
        out = await buildExportFile(ctx.db, { scope: 'pathway', id: p.id });
      } else if (fmt === 'html') {
        const { buildPathwayHtml } = await import('../publish-html.js');
        out = await buildPathwayHtml(ctx.db, { id: p.id, attribution });
        mime = 'text/html;charset=utf-8';
      } else if (fmt === 'scorm') {
        const { buildPathwayScorm } = await import('../publish-scorm.js');
        out = await buildPathwayScorm(ctx.db, { id: p.id, attribution });
        mime = 'application/zip';
      } else if (fmt === 'moodle') {
        const { buildPathwayMoodleCourse } = await import('../publish-moodle.js');
        out = await buildPathwayMoodleCourse(ctx.db, { id: p.id, attribution });
        mime = 'application/zip';
      } else if (fmt === 'csv') {
        const { buildPathwayCsv } = await import('../publish-feeds.js');
        out = await buildPathwayCsv(ctx.db, { id: p.id, attribution });
        mime = 'text/csv;charset=utf-8';
      } else if (fmt === 'rss') {
        const { buildPathwayRss } = await import('../publish-feeds.js');
        const ws = p.workspace_id ? await ctx.db.getWorkspace(p.workspace_id).catch(() => null) : null;
        const siteUrl = ws?.owner && ws?.repo ? `https://github.com/${ws.owner}/${ws.repo}` : null;
        out = await buildPathwayRss(ctx.db, { id: p.id, attribution, siteUrl });
        mime = 'application/rss+xml;charset=utf-8';
      } else {
        const { buildPathwayBookmarks } = await import('/src/data/netscape.js');
        out = await buildPathwayBookmarks(ctx.db, { id: p.id });
        mime = 'text/html;charset=utf-8';
      }
      downloadFile(out.filename, out.content, mime);
      ctx.announce(`Exported ${out.filename}.`);
      dlg.close('ok');
    } catch (ex) { err.textContent = ex.message || 'Export failed.'; submit.disabled = false; }
    finally { dlg.removeAttribute('aria-busy'); }
  });
  dlg.append(form);
  document.body.append(dlg);
  dlg.addEventListener('close', () => { dlg.remove(); invoker?.focus?.(); }, { once: true });
  dlg.showModal();
  form.querySelector('h2').focus();
}

// P10 1b: the publish dialog — the auto-update loop in one place, self-explanatory. The package
// (packages/<id>.zip) rides ordinary commits whenever this pathway changes (opt-in toggle), so
// "publishing" after day zero is just… committing. Publish now is for the first publish (and is
// blocked while the workspace has uncommitted changes — a publish commit must not carry
// unreviewed edits along uninvited).
async function openPublishDialog({ pathway: p, ws, invoker, ctx }) {
  const { el } = await import('../dom.js');
  const { toast } = await import('../toast.js');
  const dlg = el('dialog', { class: 'pc-editor' });
  const err = el('p', { class: 'field-error', role: 'alert' });
  const status = el('p', { class: 'muted', role: 'status' }, 'Checking the repository…');
  const privWarn = el('p', { class: 'field-error', 'data-publish-private': p.id, hidden: true },
    '⚠ This repository is PRIVATE. Moodle downloads the package without credentials, so the URL will 404 — the auto-update loop can’t work until the repository is public.');
  const urlInput = el('input', { type: 'text', readonly: true, 'aria-label': 'Published package URL', hidden: true, style: 'flex:1;min-width:0' });
  const copyBtn = el('button', { type: 'button', class: 'btn btn--sm', hidden: true }, 'Copy URL');
  const toggle = el('input', { type: 'checkbox', 'data-publish-toggle': p.id });
  const publishBtn = el('button', { type: 'button', class: 'btn btn--primary', 'data-requires-primary': true, 'data-publish-now': p.id }, 'Publish now');
  const publishHint = el('p', { class: 'muted publish-hint' });
  const mbzBtn = el('button', { type: 'button', class: 'btn', hidden: true }, '⬇ Auto-updating Moodle course (.mbz)');

  toggle.checked = false;
  ctx.db.getSetting(`publish_scorm:${p.id}`).then((v) => { toggle.checked = v === '1'; }).catch(() => {});
  toggle.addEventListener('change', () => {
    ctx.sync.setScormPublish(p.id, toggle.checked)
      .then(() => ctx.announce(toggle.checked
        ? 'Publishing on: commits that change this pathway will also update the package.'
        : 'Publishing off: the committed package stays but will no longer be updated.'))
      .catch((e) => { err.textContent = e.message || 'Could not save.'; toggle.checked = !toggle.checked; });
  });

  async function probe() {
    try {
      const info = await ctx.sync.scormPublishInfo(ws.id, p.id);
      const st = await ctx.sync._computeStatus(ws.id);
      if (!info) { status.textContent = 'This workspace isn’t connected to a repository.'; publishBtn.disabled = true; return; }
      const priv = info.repoPrivate === true;
      privWarn.hidden = !priv;
      if (info.exists) {
        status.textContent = 'Published ✓ — the package is in the repository. Paste this URL into Moodle once:';
        urlInput.value = info.url; urlInput.hidden = false; copyBtn.hidden = false; mbzBtn.hidden = false;
        publishBtn.textContent = 'Publish update now';
      } else {
        status.textContent = 'Not published yet — no package in the repository.';
        publishBtn.textContent = 'Publish now';
      }
      // A private repo doesn't just deserve a warning — the loop CANNOT work, so publishing is
      // paused outright (opting OUT stays possible; opting in doesn't).
      mbzBtn.disabled = priv;
      toggle.disabled = priv && !toggle.checked;
      if (priv) {
        publishBtn.disabled = true;
        publishHint.textContent = 'Publishing is paused while the repository is private. Make it public (repo Settings → General → Change visibility), then reopen this dialog.';
      } else if (st.dirty) {
        publishBtn.disabled = true;
        publishHint.textContent = 'You have uncommitted changes — commit them first (with the toggle on, the commit publishes the package too).';
      } else {
        publishBtn.disabled = false;
        publishHint.textContent = info.exists
          ? 'Only needed after app updates or an attribution change — ordinary edits publish through normal commits.'
          : 'Commits the current pathway as packages/' + p.id + '.zip. After that, the toggle keeps it fresh automatically.';
      }
    } catch (e) { status.textContent = 'Couldn’t reach the repository (offline, or the token expired).'; publishBtn.disabled = true; }
  }

  copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(urlInput.value); toast('URL copied.'); }
    catch { urlInput.hidden = false; urlInput.select(); toast('Copy blocked — the URL is selected, press Ctrl/⌘ C.'); }
  });
  publishBtn.addEventListener('click', async () => {
    err.textContent = ''; publishBtn.disabled = true; dlg.setAttribute('aria-busy', 'true');
    try {
      const r = await ctx.sync.publishScorm(ws.id, p.id);
      if (!r.committed) throw new Error(r.reason === 'remote-ahead' ? 'The repository moved — pull first, then publish.' : 'Nothing was committed.');
      ctx.announce('Package published to the repository.');
      await probe();
    } catch (e) { err.textContent = e.message || 'Could not publish.'; publishBtn.disabled = false; }
    finally { dlg.removeAttribute('aria-busy'); }
  });
  mbzBtn.addEventListener('click', async () => {
    err.textContent = '';
    try {
      const { buildPathwayMoodleCourse } = await import('../publish-moodle.js');
      const { downloadFile } = await import('../download.js');
      const attribution = (await ctx.db.getSetting('publish_attribution')) === '1';
      const out = await buildPathwayMoodleCourse(ctx.db, { id: p.id, attribution, packageUrl: urlInput.value });
      downloadFile(out.filename, out.content, 'application/zip');
      ctx.announce(`Exported ${out.filename} — restore it in Moodle; the course checks the URL daily.`);
    } catch (e) { err.textContent = e.message || 'Could not build the course file.'; }
  });

  const form = el('form', { novalidate: true, 'aria-labelledby': 'pub-h' },
    el('h2', { id: 'pub-h', 'data-view-heading': true, tabindex: -1 }, `Publish — ${p.name}`),
    el('p', {}, 'Keeps a SCORM package of this pathway committed in the repository at a stable URL. ',
      'A Moodle activity pointed at that URL (with auto-update on) refreshes itself — fix a link here, commit, and every course follows within a day.'),
    status,
    privWarn,
    el('div', { class: 'row', style: 'align-items:center' }, urlInput, copyBtn),
    el('label', { class: 'field-label', style: 'display:flex;gap:.5rem;align-items:center;font-weight:400' }, toggle,
      ' Keep it published — every commit that changes this pathway also updates the package'),
    publishHint,
    err,
    el('div', { class: 'form-actions' }, el('button', { type: 'button', class: 'btn' }, 'Close'), mbzBtn, publishBtn),
    el('details', { class: 'publish-notes' }, el('summary', {}, 'Moodle setup notes'),
      el('ul', {},
        el('li', {}, 'The repository must be public — Moodle downloads the package without credentials.'),
        el('li', {}, 'A site admin must enable URL packages once: Site administration → Plugins → SCORM package → “Downloaded package” type — NOT its neighbour “External SCORM manifest”, which wants an imsmanifest.xml URL and rejects zips as “Invalid URL”.'),
        el('li', {}, 'Symptom of that toggle being off: the course restores and plays fine, but SAVING the activity’s settings fails with “Column \u2018reference\u2019 cannot be null” — the form omits the Package URL field until the type is enabled.'),
        el('li', {}, 'In the activity: paste the URL as the Package, set Auto-update frequency to “Every day”.'),
        el('li', {}, 'Or skip the setup: download the auto-updating course file above and restore it as a new course.'))));
  form.addEventListener('submit', (e) => e.preventDefault());
  form.querySelector('.form-actions .btn').addEventListener('click', () => dlg.close('cancel'));
  dlg.append(form);
  document.body.append(dlg);
  dlg.addEventListener('close', () => { dlg.remove(); invoker?.focus?.(); }, { once: true });
  dlg.showModal();
  form.querySelector('h2').focus();
  probe();
}
