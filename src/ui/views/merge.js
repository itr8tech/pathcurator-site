// src/ui/views/merge.js — interactive pull review (#/merge/:wsId). Shown when a pull finds a
// TRUE conflict (both sides edited) or an edit-vs-delete. Remote content is UNTRUSTED: names
// render as textContent, descriptions through the sanitizer (ctx.md). URLs are never live hrefs.
import { el, clear } from '../dom.js';
import { REVIEW_CHOICES } from '../../data/merge.js';
import { summarizeDiff } from '../pathway-diff.js';
import { announce } from '../a11y.js';

const CHOICE_LABEL = {
  'keep-local': 'Keep my version',
  replace: 'Use their version',
  delete: 'Accept their deletion',
  add: 'Restore their version',
  skip: 'Keep it deleted',
};
const STATUS_LABEL = {
  conflict: 'Edited on both sides',
  'remote-deleted-local-edited': 'You edited it; they deleted it',
  'local-deleted-remote-edited': 'You deleted it; they edited it',
};


export default async function mount(container, params, ctx) {
  const root = el('div', { class: 'view-content' });
  container.append(root);
  const wsId = params.wsId;
  const controller = { title: 'Review changes', destroy() {} };

  const context = ctx.sync?.getPendingPull?.(wsId) || null;
  if (!context) {
    root.append(
      el('h1', { 'data-view-heading': true, tabindex: -1 }, 'Nothing to review'),
      el('p', { class: 'muted' }, 'There are no pulled changes waiting for review.'),
      el('p', {}, el('a', { class: 'btn', href: '#/' }, 'Back to pathways')));
    return controller;
  }

  const { plan, remoteObjs } = context;
  root.append(el('h1', { 'data-view-heading': true, tabindex: -1 }, 'Review incoming changes'));

  // What will apply automatically (safe cases)
  const autoBits = [];
  const c = plan.counts || {};
  if (c.added) autoBits.push(`${c.added} added`);
  if (c['ff-remote']) autoBits.push(`${c['ff-remote']} updated`);
  if (c['remote-deleted']) autoBits.push(`${c['remote-deleted']} removed`);
  root.append(el('p', { class: 'muted' },
    autoBits.length ? `Applying automatically: ${autoBits.join(', ')}. The items below need your decision.`
      : 'The items below were changed on both sides and need your decision.'));

  const form = el('form', { class: 'merge-form' });
  const previewInto = (host, md) => { if (md) ctx.md.renderMarkdownInto(host, md); else host.append(el('span', { class: 'muted' }, '—')); };

  for (const item of plan.review) {
    const cfg = REVIEW_CHOICES[item.status] || { choices: ['keep-local'], default: 'keep-local' };
    const local = await ctx.db.getPathway(item.id);
    const remote = remoteObjs[item.id]?.pathway || null;
    const name = local?.name || remote?.name || item.id;

    const fs = el('fieldset', { class: 'merge-item' });
    fs.append(el('legend', {}, name, ' ', el('span', { class: 'merge-status' }, STATUS_LABEL[item.status] || item.status)));

    // Full-scope difference summary — only meaningful when both sides exist (a true conflict).
    if (local && remote) {
      const localImg = local.header_image_id ? await ctx.db.getAttachment(local.header_image_id) : null;
      const diffs = summarizeDiff(local, remote, localImg?.sha256 || null, remote.header_image?.sha256 || null);
      fs.append(el('div', { class: 'merge-diff' },
        el('h3', {}, 'What differs'),
        el('ul', {}, diffs.map((d) => el('li', {}, d)))));
    }

    const cols = el('div', { class: 'merge-cols' });
    const mine = el('div', { class: 'merge-col' }, el('h3', {}, 'Your version'));
    const theirs = el('div', { class: 'merge-col' }, el('h3', {}, 'Their version'));
    if (local) { mine.append(el('strong', {}, local.name)); const d = el('div', { class: 'prose' }); previewInto(d, local.description); mine.append(d); }
    else mine.append(el('p', { class: 'muted' }, 'Deleted locally'));
    if (remote) { theirs.append(el('strong', {}, remote.name)); const d = el('div', { class: 'prose' }); previewInto(d, remote.description); theirs.append(d); }
    else theirs.append(el('p', { class: 'muted' }, 'Removed on remote'));
    cols.append(mine, theirs);
    fs.append(cols);

    const choices = el('div', { class: 'merge-choices', role: 'radiogroup', 'aria-label': `Resolution for ${name}` });
    cfg.choices.forEach((ch) => {
      choices.append(el('label', {},
        el('input', { type: 'radio', name: `res:${item.id}`, value: ch, checked: ch === cfg.default }),
        ' ' + (CHOICE_LABEL[ch] || ch)));
    });
    fs.append(choices);
    form.append(fs);
  }

  const err = el('p', { class: 'field-error', role: 'alert' });
  const apply = el('button', { type: 'submit', class: 'btn btn--primary', 'data-requires-primary': true }, 'Apply resolutions');
  form.append(err, el('div', { class: 'form-actions' },
    el('a', { class: 'btn', href: '#/' }, 'Cancel'), apply));

  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    const resolutions = {};
    for (const item of plan.review) {
      const picked = form.querySelector(`input[name="res:${CSS.escape(item.id)}"]:checked`);
      if (picked) resolutions[item.id] = picked.value;
    }
    apply.disabled = true; root.setAttribute('aria-busy', 'true');
    try {
      const res = await ctx.sync.resolvePull(wsId, resolutions);
      announce(`Changes applied: ${res.added} added, ${res.replaced} updated, ${res.deleted} removed.`);
      ctx.navigate('/');
    } catch (ex) {
      err.textContent = ex?.message || 'Could not apply the changes.';
      apply.disabled = false;
    } finally {
      root.removeAttribute('aria-busy');
    }
  });

  root.append(form);
  return controller;
}
