// src/ui/sync-indicator.js — the sync UI kit: per-workspace sync row (chip + Commit/Pull +
// auto-commit) and commit dialog, the read-only chip, and the global header badge on the "Sync"
// nav link. Primary-only controls carry data-requires-primary.
import { el } from './dom.js';
import { summarizeDiff } from './pathway-diff.js';
import { announce } from './a11y.js';
import { toast } from './toast.js';

const CHIP = {
  clean: { text: () => 'In sync', cls: 'ok' },
  dirty: { text: (n) => `${n} uncommitted`, cls: 'warn' },
  conflict: { text: () => 'Conflict — pull to review', cls: 'danger' },
  'never-committed': { text: () => 'Not yet committed', cls: 'warn' },
  disconnected: { text: () => 'Not connected', cls: 'muted' },
  error: { text: () => 'Sync error', cls: 'danger' },
};

// VISIBLE feedback (toast + busy button): announce() alone feeds only the hidden live region, which
// made a successful Pull look like nothing happened.
export async function doPull(ws, ctx, invoker = null) {
  const prevText = invoker?.textContent;
  if (invoker) { invoker.disabled = true; invoker.textContent = 'Pulling…'; }
  try {
    const res = await ctx.sync.pull(ws.id);
    if (res.needsReview) { toast(`${ws.org_label}: changes need review.`); ctx.navigate(`/merge/${encodeURIComponent(ws.id)}`); return; }
    if (res.legacy) { offerLegacyImport(ws, ctx); return; }         // P6: unmigrated legacy repo
    if (res.ok === false && res.reason === 'no-manifest') {
      toast('This repository has no PathCurator content yet — your first Commit will initialize it.');
      return;
    }
    if (res.upToDate) toast(`${ws.org_label}: already up to date ✓`);
    else toast(`${ws.org_label}: pulled — ${res.applied.added} added, ${res.applied.replaced} updated, ${res.applied.deleted} removed.`);
  } catch (e) { toast(e.message || 'Could not pull.'); }
  finally { if (invoker?.isConnected) { invoker.disabled = false; invoker.textContent = prevText; } }
}

// P6: the repo stores its pathways in the legacy single-file format — offer to import them.
export function offerLegacyImport(ws, ctx, invoker = null) {
  const dlg = el('dialog', { class: 'pc-editor' });
  const err = el('p', { class: 'field-error', role: 'alert' });
  const importBtn = el('button', { type: 'button', class: 'btn btn--primary', 'data-requires-primary': true, 'data-legacy-import': ws.id }, 'Import pathways');
  const form = el('form', { 'aria-labelledby': 'legacy-h' },
    el('h2', { id: 'legacy-h', 'data-view-heading': true, tabindex: -1 }, `Legacy PathCurator repository — ${ws.org_label}`),
    el('p', {}, 'This repository stores its pathways in the legacy single-file format (', el('code', {}, 'curator-pathways.json'), '). Import them into this workspace?'),
    el('p', { class: 'muted' }, 'Imported pathways arrive as uncommitted local changes — review them, then Commit to write them to the repository in the new per-pathway format. The legacy file itself is not modified, so the old app keeps working alongside.'),
    err,
    el('div', { class: 'form-actions' }, el('button', { type: 'button', class: 'btn' }, 'Not now'), importBtn));
  form.querySelector('.form-actions .btn').addEventListener('click', () => dlg.close('cancel'));
  importBtn.addEventListener('click', async () => {
    err.textContent = ''; importBtn.disabled = true; dlg.setAttribute('aria-busy', 'true');
    try {
      const r = await ctx.sync.importLegacy(ws.id);
      announce(`Imported ${r.added} pathway${r.added === 1 ? '' : 's'} from the legacy file${r.quarantined ? ` (${r.quarantined} unsafe link${r.quarantined === 1 ? '' : 's'} skipped)` : ''}. Commit when ready to write the new format.`);
      dlg.close('ok');
    } catch (e) { err.textContent = e.message || 'Could not import.'; importBtn.disabled = false; }
    finally { dlg.removeAttribute('aria-busy'); }
  });
  dlg.append(form);
  document.body.append(dlg);
  dlg.addEventListener('close', () => { dlg.remove(); invoker?.focus?.(); }, { once: true });
  dlg.showModal();
  form.querySelector('h2').focus();
}

// A standalone status chip (no actions) — for follower tabs and the sync overview.
export function syncChip(st, wsId = null) {
  const spec = CHIP[st.state] || CHIP.disconnected;
  return el('span', { class: `sync-chip sync-chip--${spec.cls}`, role: 'status', ...(wsId ? { 'data-sync-chip': wsId } : {}) },
    spec.text(st.uncommittedCount));
}

export function syncRow(ws, st, ctx) {
  const row = el('div', { class: 'sync-row', 'data-ws-sync': ws.id });
  row.append(syncChip(st, ws.id));
  if (!st.connected) return row;

  // Audit-side changes (P5: overrides + exemptions) justify a commit on their own — zero content edits.
  if (st.auditDirty) row.append(el('span', { class: 'muted sync-audit-pending', 'data-sync-audit-dirty': ws.id }, 'audit changes pending'));

  const commitBtn = el('button', { type: 'button', class: 'btn btn--sm', 'data-requires-primary': true, 'data-sync-commit': ws.id }, 'Commit…');
  commitBtn.disabled = st.remoteAhead || !(st.dirty || st.auditDirty || st.state === 'never-committed');
  commitBtn.addEventListener('click', (ev) => openCommitDialog(ws, st, ev.currentTarget, ctx));

  const reviewBtn = el('button', { type: 'button', class: 'btn btn--sm', 'data-requires-primary': true, 'data-sync-review': ws.id }, 'Review…');
  reviewBtn.addEventListener('click', (ev) => openReviewChanges(ws, ev.currentTarget, ctx));
  if (st.state !== 'dirty') reviewBtn.hidden = true;   // review/discard needs a committed baseline

  const pullBtn = el('button', { type: 'button', class: 'btn btn--sm', 'data-requires-primary': true, 'data-sync-pull': ws.id }, st.remoteAhead ? 'Pull & review' : 'Pull');
  pullBtn.addEventListener('click', (ev) => doPull(ws, ctx, ev.currentTarget));

  const auto = el('label', { class: 'sync-auto' }, el('input', { type: 'checkbox', 'data-sync-auto': ws.id }), ' Auto-commit');
  const autoInput = auto.querySelector('input');
  ctx.sync.getAutoCommit(ws.id).then((c) => { autoInput.checked = !!c.enabled; }).catch(() => {});
  autoInput.addEventListener('change', () => ctx.sync.setAutoCommit(ws.id, { enabled: autoInput.checked }).catch(() => {}));

  row.append(commitBtn, reviewBtn, pullBtn, auto);
  return row;
}

// Review uncommitted changes (what differs vs the last commit) with the option to DISCARD them
// (revert to the committed version — never touches the repo). Fetches the committed baseline to diff.
export async function openReviewChanges(ws, invoker, ctx) {
  const dlg = el('dialog', { class: 'pc-editor' });
  const heading = el('h2', { id: 'review-h', 'data-view-heading': true, tabindex: -1 }, `Uncommitted changes — ${ws.org_label}`);
  const bodyWrap = el('div', {}, el('p', { class: 'muted' }, 'Loading changes…'));
  const err = el('p', { class: 'field-error', role: 'alert' });
  const discardBtn = el('button', { type: 'button', class: 'btn btn--danger', 'data-requires-primary': true, disabled: true }, 'Discard all changes');
  const form = el('form', { 'aria-labelledby': 'review-h' }, heading, bodyWrap, err,
    el('div', { class: 'form-actions' }, el('button', { type: 'button', class: 'btn' }, 'Close'), discardBtn));
  form.querySelector('.form-actions .btn').addEventListener('click', () => dlg.close('cancel'));
  dlg.append(form);
  document.body.append(dlg);
  dlg.addEventListener('close', () => { dlg.remove(); invoker?.focus?.(); }, { once: true });
  dlg.showModal();
  heading.focus();

  try {
    const uc = await ctx.db.getUncommittedCount(ws.id);
    const changedIds = uc.changedPathwayIds || [], removedIds = uc.removedPathwayIds || [];
    const committed = await ctx.sync.fetchCommittedPathways(ws.id, [...changedIds, ...removedIds]);
    const nameById = new Map((await ctx.db.listPathways()).map((p) => [p.id, p.name]));
    const list = el('div', { class: 'review-list' });
    for (const id of changedIds) {
      const local = await ctx.db.getPathway(id);
      const remote = committed[id];
      const sec = el('section', { class: 'merge-diff' }, el('h3', {}, local?.name || nameById.get(id) || id));
      if (!remote) sec.append(el('ul', {}, el('li', {}, 'New pathway — not committed yet (Discard will remove it)')));
      else {
        const localImg = local.header_image_id ? await ctx.db.getAttachment(local.header_image_id) : null;
        // committed → current, so the diff reads as what YOU changed (added/edited), not the reverse.
        sec.append(el('ul', {}, summarizeDiff(remote, local, remote.header_image?.sha256 || null, localImg?.sha256 || null).map((d) => el('li', {}, d))));
      }
      list.append(sec);
    }
    for (const id of removedIds) list.append(el('section', { class: 'merge-diff' },
      el('h3', {}, committed[id]?.name || id), el('ul', {}, el('li', {}, 'Deleted locally — still in the last commit (Discard will restore it)'))));
    if (!changedIds.length && !removedIds.length) list.append(el('p', { class: 'muted' }, 'No uncommitted changes.'));
    const body = el('div', {}, el('p', { class: 'muted' }, 'These edits aren’t committed to the repo. Discarding reverts them to the last committed version — it never changes the repo.'), list);
    dlg.querySelector('form').replaceChild(body, bodyWrap);
    discardBtn.disabled = !(changedIds.length || removedIds.length);
  } catch (e) { err.textContent = e.message || 'Could not load the changes.'; }

  let armed = false;
  discardBtn.addEventListener('click', async () => {
    err.textContent = '';
    if (!armed) { armed = true; discardBtn.textContent = 'Confirm — discard all changes'; return; }
    discardBtn.disabled = true; dlg.setAttribute('aria-busy', 'true');
    try { await ctx.sync.discardLocalChanges(ws.id); announce('Uncommitted changes discarded.'); dlg.close('ok'); }
    catch (e) { err.textContent = e.message || 'Could not discard the changes.'; discardBtn.disabled = false; armed = false; discardBtn.textContent = 'Discard all changes'; }
    finally { dlg.removeAttribute('aria-busy'); }
  });
}

export function openCommitDialog(ws, st, invoker, ctx) {
  const dlg = el('dialog', { class: 'pc-editor' });
  const msg = el('textarea', { name: 'message', rows: 2 });
  const err = el('p', { class: 'field-error', role: 'alert' });
  const submit = el('button', { type: 'submit', class: 'btn btn--primary', 'data-requires-primary': true }, 'Commit');
  const reviewBtn = el('button', { type: 'button', class: 'btn btn--primary', hidden: true }, 'Pull & review');
  const n = st.uncommittedCount;

  const what = n > 0
    ? `${n} change${n === 1 ? '' : 's'}${st.auditDirty ? ' + audit changes' : ''}`
    : (st.auditDirty ? 'Audit changes (overrides / exemptions)' : `${n} changes`);
  const form = el('form', { novalidate: true, 'aria-labelledby': 'commit-h' },
    el('h2', { id: 'commit-h', 'data-view-heading': true, tabindex: -1 }, `Commit — ${ws.org_label}`),
    el('p', { class: 'muted' }, `${what} to commit to ${ws.owner}/${ws.repo}.`),
    el('label', {}, 'Message (optional)', msg),
    err,
    el('div', { class: 'form-actions' }, el('button', { type: 'button', class: 'btn' }, 'Cancel'), reviewBtn, submit));
  form.querySelector('.form-actions .btn').addEventListener('click', () => dlg.close('cancel'));

  reviewBtn.addEventListener('click', async () => { dlg.close('ok'); await doPull(ws, ctx); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    submit.disabled = true; dlg.setAttribute('aria-busy', 'true');
    try {
      const res = await ctx.sync.commit(ws.id, { message: msg.value.trim() || undefined });
      if (res.ok && res.committed) { toast(`${ws.org_label}: committed ✓`); dlg.close('ok'); }
      else if (res.reason === 'no-changes') { toast('Nothing to commit.'); dlg.close('ok'); }
      else if (res.reason === 'remote-ahead') {
        err.textContent = 'Someone else has pushed changes since your last sync. Pull and review before committing.';
        submit.hidden = true; reviewBtn.hidden = false; reviewBtn.focus();
      } else { err.textContent = 'Could not commit.'; submit.disabled = false; }
    } catch (ex) { err.textContent = ex.message || 'Could not commit.'; submit.disabled = false; }
    finally { dlg.removeAttribute('aria-busy'); }
  });

  dlg.append(form);
  document.body.append(dlg);
  dlg.addEventListener('close', () => { dlg.remove(); invoker?.focus?.(); }, { once: true });
  dlg.showModal();
  msg.focus();
}

// The global header badge on the "Sync" nav link: cross-workspace uncommitted count, or a conflict
// marker, kept live off the sync status cache. Hidden when everything is clean; announces once when
// a conflict first appears. Not colour-only — the count/"!" glyph carries the state as text.
export function mountSyncBadge(sync) {
  const link = document.getElementById('nav-sync');
  const badge = document.getElementById('sync-badge');
  if (!link || !badge) return () => {};
  let hadConflict = false;
  const render = () => {
    const conflict = sync.hasConflict();
    const total = sync.totalUncommitted();
    if (conflict) {
      badge.hidden = false; badge.textContent = '!'; badge.className = 'sync-badge sync-badge--danger';
      link.setAttribute('aria-label', 'Sync — conflicts need review'); link.classList.add('has-alert');
      if (!hadConflict) announce('Sync conflict — pull to review.');
    } else if (total > 0) {
      badge.hidden = false; badge.textContent = String(total); badge.className = 'sync-badge sync-badge--warn';
      link.setAttribute('aria-label', `Sync — ${total} uncommitted change${total === 1 ? '' : 's'}`); link.classList.remove('has-alert');
    } else {
      badge.hidden = true; badge.textContent = ''; link.setAttribute('aria-label', 'Sync'); link.classList.remove('has-alert');
    }
    hadConflict = conflict;
  };
  const unsub = sync.onStatusChange(render);
  render();
  return unsub;
}
