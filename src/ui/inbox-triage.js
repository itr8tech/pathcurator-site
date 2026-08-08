// src/ui/inbox-triage.js — dialogs for the inbox: "File this into a pathway" (cascading
// workspace → pathway → step, prefilled from the item; files it as a URL-guarded bookmark via
// db.triageInboxItem) and "Add manually". Native <dialog>, matching connect.js/editors.js. Both
// submits carry data-requires-primary.
import { el } from './dom.js';
import { announce } from './a11y.js';

const CONTENT_TYPES = ['Read', 'Watch', 'Listen', 'Participate'];

function mountDialog(dlg, invoker) {
  document.body.append(dlg);
  dlg.addEventListener('close', () => { dlg.remove(); invoker?.focus?.(); }, { once: true });
  dlg.showModal();
}

export async function openInboxTriage({ item, invoker, ctx }) {
  const [workspaces, pathways] = await Promise.all([ctx.db.getWorkspaces(), ctx.db.listPathways()]);
  const dlg = el('dialog', { class: 'pc-editor' });

  if (!pathways.length) {
    dlg.append(el('form', { method: 'dialog' },
      el('h2', { 'data-view-heading': true, tabindex: -1 }, 'Nowhere to file this yet'),
      el('p', { class: 'muted' }, 'Create a pathway with at least one step first, then file this item into it.'),
      el('div', { class: 'form-actions' }, el('button', { class: 'btn btn--primary', value: 'ok' }, 'OK'))));
    mountDialog(dlg, invoker); dlg.querySelector('[data-view-heading]')?.focus();
    return;
  }

  const wsSel = el('select', { name: 'ws' });
  const pwSel = el('select', { name: 'pw' });
  const stepSel = el('select', { name: 'step' });
  const title = el('input', { name: 'title', type: 'text', value: item.title || '' });
  const url = el('input', { name: 'url', type: 'url', required: true, value: item.url || '' });
  // Prefill what capture collected: the page's meta description, and the user's own note as the
  // bookmark's context — visible + editable here so filing never silently drops them.
  const description = el('textarea', { name: 'description', rows: 3 }, item.description || '');
  const context = el('textarea', { name: 'context', rows: 2 }, item.note || '');
  const ct = el('select', { name: 'content_type' }, ...CONTENT_TYPES.map((v) => el('option', { value: v, selected: v === (item.content_type || 'Read') }, v)));
  const required = el('input', { type: 'checkbox', name: 'required', checked: true });
  const err = el('p', { class: 'field-error', role: 'alert' });
  const submit = el('button', { type: 'submit', class: 'btn btn--primary', 'data-requires-primary': true }, 'File it');

  for (const id of [...new Set(pathways.map((p) => p.workspace_id))]) {
    const w = workspaces.find((x) => x.id === id);
    wsSel.append(el('option', { value: id }, w ? w.org_label : 'Workspace'));
  }
  function fillPathways() {
    pwSel.replaceChildren(...pathways.filter((p) => p.workspace_id === wsSel.value).map((p) => el('option', { value: p.id }, p.name)));
    return fillSteps();
  }
  async function fillSteps() {
    const steps = (await ctx.db.getPathway(pwSel.value))?.steps || [];
    stepSel.replaceChildren(...(steps.length
      ? steps.map((s) => el('option', { value: s.id }, s.name))
      : [el('option', { value: '' }, '(this pathway has no steps yet)')]));
  }
  wsSel.addEventListener('change', fillPathways);
  pwSel.addEventListener('change', fillSteps);
  await fillPathways();

  const form = el('form', { novalidate: true, 'aria-labelledby': 'triage-h' },
    el('h2', { id: 'triage-h', 'data-view-heading': true, tabindex: -1 }, 'File into a pathway'),
    el('div', { class: 'field-row' }, el('label', {}, 'Workspace', wsSel), el('label', {}, 'Pathway', pwSel)),
    el('label', {}, 'Step', stepSel),
    el('label', {}, 'Title', title),
    el('label', {}, 'Link', url),
    el('label', {}, 'Description', description),
    el('label', {}, 'Context', context),
    el('div', { class: 'field-row' }, el('label', {}, 'Type', ct), el('label', {}, required, ' Required')),
    err,
    el('div', { class: 'form-actions' }, el('button', { type: 'button', class: 'btn' }, 'Cancel'), submit));
  form.querySelector('.form-actions .btn').addEventListener('click', () => dlg.close('cancel'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    if (!stepSel.value) { err.textContent = 'Pick a step — this pathway needs at least one.'; return; }
    submit.disabled = true; dlg.setAttribute('aria-busy', 'true');
    try {
      const pwName = pwSel.selectedOptions[0]?.textContent || 'the pathway';
      await ctx.db.triageInboxItem({ id: item.id, step_id: stepSel.value, title: title.value.trim(),
        url: url.value.trim(), description: description.value.trim(), context: context.value.trim(),
        content_type: ct.value, required: required.checked ? 1 : 0 });
      announce(`Filed into ${pwName}.`);
      dlg.close('ok');
    } catch (ex) { err.textContent = ex.message || 'Could not file this item.'; submit.disabled = false; }
    finally { dlg.removeAttribute('aria-busy'); }
  });

  dlg.append(form);
  mountDialog(dlg, invoker);
  form.querySelector('[data-view-heading]')?.focus();
}

export function openManualAdd({ invoker, ctx }) {
  const dlg = el('dialog', { class: 'pc-editor' });
  const url = el('input', { name: 'url', type: 'url', required: true, placeholder: 'https://…' });
  const title = el('input', { name: 'title', type: 'text' });
  const note = el('textarea', { name: 'note', rows: 2 });
  const ct = el('select', { name: 'content_type' }, ...CONTENT_TYPES.map((v) => el('option', { value: v }, v)));
  const err = el('p', { class: 'field-error', role: 'alert' });
  const submit = el('button', { type: 'submit', class: 'btn btn--primary', 'data-requires-primary': true }, 'Add');

  const form = el('form', { novalidate: true, 'aria-labelledby': 'madd-h' },
    el('h2', { id: 'madd-h', 'data-view-heading': true, tabindex: -1 }, 'Add to inbox'),
    el('label', {}, 'Link', url),
    el('label', {}, 'Title (optional)', title),
    el('label', {}, 'Note (optional)', note),
    el('label', {}, 'Type', ct),
    err,
    el('div', { class: 'form-actions' }, el('button', { type: 'button', class: 'btn' }, 'Cancel'), submit));
  form.querySelector('.form-actions .btn').addEventListener('click', () => dlg.close('cancel'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    const u = url.value.trim();
    if (!u) { err.textContent = 'A link is required.'; url.focus(); return; }
    submit.disabled = true; dlg.setAttribute('aria-busy', 'true');
    try {
      await ctx.db.addToInboxManually({ url: u, title: title.value.trim() || null, note: note.value.trim() || null, content_type: ct.value });
      announce('Added to your inbox.'); dlg.close('ok');
    } catch (ex) { err.textContent = ex.message || 'Could not add this.'; submit.disabled = false; }
    finally { dlg.removeAttribute('aria-busy'); }
  });

  dlg.append(form);
  mountDialog(dlg, invoker);
  url.focus();
}
