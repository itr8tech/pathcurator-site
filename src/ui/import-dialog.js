// src/ui/import-dialog.js — P6: the import-review dialog. Feed it a File; it plans the import
// (detect kind → normalize → classify per stable id), shows every pathway with a status chip
// (new / identical / conflict / exists-elsewhere), per-conflict Keep-mine ⁄ Take-import radios
// (default KEEP — imports never clobber silently) with a lazy diff, bulk controls, and a target
// workspace picker (per group for workspace/backup files, incl. "create new"). Import applies via
// the quarantining worker path and lands as ordinary uncommitted changes. Primary-only.
import { el } from './dom.js';
import { announce } from './a11y.js';
import { planImport, applyImport, matchGroupTarget } from '/src/data/exchange.js';
import { summarizeDiff } from './pathway-diff.js';

const KIND_LABEL = {
  'pathcurator-pathway': 'Pathway export', 'pathcurator-workspace': 'Workspace export',
  'pathcurator-backup': 'Full backup', 'raw-pathway': 'Committed pathway file',
  'v2-pathway-list': 'Pathway list', legacy: 'Legacy PathCurator export',
  csv: 'Link spreadsheet (CSV)', bookmarks: 'Browser bookmarks (HTML)',
};

export async function openImportDialog({ file, invoker, ctx }) {
  const dlg = el('dialog', { class: 'pc-editor import-dialog' });
  document.body.append(dlg);
  dlg.addEventListener('close', () => { dlg.remove(); invoker?.focus?.(); }, { once: true });
  const form = el('form', { novalidate: true, 'aria-labelledby': 'imp-h' });
  const heading = el('h2', { id: 'imp-h', 'data-view-heading': true, tabindex: -1 }, 'Import file');
  form.append(heading, el('p', { class: 'muted' }, `Reading ${file.name}…`));
  dlg.append(form);
  dlg.showModal();
  heading.focus();

  const closeBtn = el('button', { type: 'button', class: 'btn' }, 'Cancel');
  closeBtn.addEventListener('click', () => dlg.close('cancel'));

  let plan;
  try {
    plan = await planImport(ctx.db, await file.text(), { safeUrl: ctx.md.safeUrl, filename: file.name });
  } catch (e) {
    form.replaceChildren(heading, el('p', { class: 'field-error', role: 'alert' }, e.message || 'Could not read this file.'),
      el('div', { class: 'form-actions' }, closeBtn));
    return;
  }

  const workspaces = await ctx.db.getWorkspaces();
  const resolutions = {};                                  // id → 'keep' | 'take'
  for (const it of plan.items) if (it.existsIn && !it.identical) resolutions[it.id] = 'keep';

  // ---- target pickers ----
  const wsOption = (w) => el('option', { value: w.id }, `${w.org_label}${w.owner ? ` (connected: ${w.owner}/${w.repo})` : ''}`);
  const groupSelects = [];
  let singleTarget = null;
  const targetsUi = [];
  if (plan.groups.length) {
    plan.groups.forEach((group, i) => {
      const matched = matchGroupTarget(group, workspaces, plan.items);
      const sel = el('select', { 'data-import-target': i },
        el('option', { value: 'create' }, `＋ Create workspace “${group.workspace?.orgLabel || 'Imported workspace'}”`),
        ...workspaces.map(wsOption));
      sel.value = matched ? matched.id : 'create';
      groupSelects.push(sel);
      targetsUi.push(el('label', {}, `Import “${group.workspace?.orgLabel || `group ${i + 1}`}” into`, sel));
    });
  } else {
    singleTarget = el('select', { 'data-import-target': 'single' }, ...workspaces.map(wsOption));
    if (!workspaces.length) singleTarget.append(el('option', { value: '' }, '(no workspaces — create one first)'));
    targetsUi.push(el('label', {}, 'Import into workspace', singleTarget));
  }

  // ---- item rows ----
  const statusOf = (it) => it.identical ? 'identical' : it.existsIn ? 'conflict' : 'new';
  const rows = el('ul', { class: 'import-list', role: 'list' });
  for (const it of plan.items) {
    const st = statusOf(it);
    const li = el('li', { class: `import-row import-row--${st}`, 'data-import-id': it.id });
    li.append(el('div', { class: 'import-row__head' }, el('strong', {}, it.name), ' ',
      el('span', { class: `import-chip import-chip--${st}` },
        st === 'new' ? 'new' : st === 'identical' ? 'identical — no change' : `differs from your copy${it.existsInLabel ? ` (in ${it.existsInLabel})` : ''}`)));
    if (st === 'conflict') {
      const keep = el('input', { type: 'radio', name: `res-${it.id}`, value: 'keep', checked: true });
      const take = el('input', { type: 'radio', name: `res-${it.id}`, value: 'take' });
      for (const r of [keep, take]) r.addEventListener('change', () => { if (r.checked) resolutions[it.id] = r.value; });
      li.append(el('div', { class: 'import-row__choice' },
        el('label', {}, keep, ' Keep mine'), el('label', {}, take, ' Take import')));
      const det = el('details', { class: 'merge-diff' }, el('summary', {}, 'What differs'));
      det.addEventListener('toggle', async () => {
        if (!det.open || det.dataset.loaded) return;
        det.dataset.loaded = '1';
        try {
          const ser = await ctx.db.serializePathway(it.id);
          const mine = ser?.obj?.pathway, theirs = it.pathway.pathway;
          const diffs = summarizeDiff(mine, theirs, mine?.header_image?.sha256 || null, theirs.header_image?.sha256 || null);
          det.append(el('ul', {}, (diffs.length ? diffs : ['Only metadata differs.']).map((d) => el('li', {}, d))));
        } catch { det.append(el('p', { class: 'muted' }, 'Could not load the comparison.')); }
      });
      li.append(det);
    }
    rows.append(li);
  }

  const conflicts = plan.items.filter((it) => statusOf(it) === 'conflict');
  const bulk = [];
  if (conflicts.length > 1) {
    const setAll = (v) => {
      for (const it of conflicts) {
        resolutions[it.id] = v;
        const r = rows.querySelector(`input[name="res-${it.id}"][value="${v}"]`);
        if (r) r.checked = true;
      }
    };
    const takeAll = el('button', { type: 'button', class: 'btn btn--sm' }, `Take import for all ${conflicts.length}`);
    const keepAll = el('button', { type: 'button', class: 'btn btn--sm' }, 'Keep mine for all');
    takeAll.addEventListener('click', () => setAll('take'));
    keepAll.addEventListener('click', () => setAll('keep'));
    bulk.push(el('div', { class: 'import-bulk' }, takeAll, keepAll));
  }

  const err = el('p', { class: 'field-error', role: 'alert' });
  const importBtn = el('button', { type: 'submit', class: 'btn btn--primary', 'data-requires-primary': true }, 'Import');
  const counts = `${plan.items.length} pathway${plan.items.length === 1 ? '' : 's'} · ${plan.items.filter((i) => statusOf(i) === 'new').length} new · ${plan.items.filter((i) => i.identical).length} identical · ${conflicts.length} differing`;

  form.replaceChildren(heading,
    el('p', { class: 'muted' }, `${KIND_LABEL[plan.kind] || plan.kind} — ${file.name}. ${counts}. Imported content arrives as uncommitted changes you can review before any commit.`),
    ...(plan.warnings.length ? [el('ul', { class: 'import-warnings' }, plan.warnings.slice(0, 8).map((w) => el('li', {}, w)),
      plan.warnings.length > 8 ? el('li', {}, `…and ${plan.warnings.length - 8} more`) : null)] : []),
    ...targetsUi, ...bulk, rows, err,
    el('div', { class: 'form-actions' }, closeBtn, importBtn));

  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    importBtn.disabled = true; dlg.setAttribute('aria-busy', 'true');
    try {
      const targets = {};
      groupSelects.forEach((sel, i) => { targets[i] = sel.value === 'create' ? 'create' : sel.value; });
      const t = await applyImport(ctx.db, plan, { targetWsId: singleTarget?.value || null, targets, resolutions });
      announce(`Imported: ${t.added} added, ${t.replaced} updated, ${t.identical} identical, ${t.skippedExisting} kept as-is` +
        `${t.quarantined ? `, ${t.quarantined} unsafe link${t.quarantined === 1 ? '' : 's'} skipped` : ''}` +
        `${t.createdWorkspaces ? `, ${t.createdWorkspaces} workspace${t.createdWorkspaces === 1 ? '' : 's'} created` : ''}.`);
      dlg.close('ok');
    } catch (ex) { err.textContent = ex.message || 'Import failed.'; importBtn.disabled = false; }
    finally { dlg.removeAttribute('aria-busy'); }
  });
}

// downloadFile moved to src/ui/download.js (P7) — re-exported for existing callers.
export { downloadFile } from './download.js';
