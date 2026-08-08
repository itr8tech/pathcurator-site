// src/ui/editors.js — native <dialog> editors (no innerHTML with user data). The change event
// drives the list re-render; editors never patch list DOM. Every mutating control is data-requires-primary.
import { el } from './dom.js';
import { mdField } from './md-editor.js';
import { announce } from './a11y.js';

function mountDialog(dlg, invoker) {
  document.body.append(dlg);
  dlg.addEventListener('close', () => { dlg.remove(); invoker?.focus?.(); }, { once: true });
  dlg.showModal();
}
const radio = (n, v, checked, label) => el('label', {}, el('input', { type: 'radio', name: n, value: v, checked }), ' ' + label);

// Header image: cover-crop to a 4:1 banner + downscale, re-encode as JPEG (universal canvas.toBlob support).
function processImageFile(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) { reject(new Error('Please choose an image file.')); return; }
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const TW = 1200, TH = 300, canvas = document.createElement('canvas');
      canvas.width = TW; canvas.height = TH;
      const c = canvas.getContext('2d');
      const scale = Math.max(TW / img.naturalWidth, TH / img.naturalHeight);
      const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
      c.drawImage(img, (TW - w) / 2, (TH - h) / 2, w, h);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process image.'))), 'image/jpeg', 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
    img.src = url;
  });
}
async function sha256Hex(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function openBookmarkEditor({ stepId, bm = null, invoker, ctx }) {
  const isEdit = !!bm, dlg = el('dialog', { class: 'pc-editor' });
  const title = el('input', { name: 'title', type: 'text', value: bm?.title ?? '', autocomplete: 'off' });
  const url = el('input', { name: 'url', type: 'url', inputmode: 'url', required: true, value: bm?.url ?? '', 'aria-describedby': 'bm-url-err', 'data-focus-key': 'bm-edit:url' });
  const urlErr = el('span', { class: 'field-error', id: 'bm-url-err', role: 'alert' });
  const desc = el('textarea', { name: 'description', rows: 3 }); desc.value = bm?.description ?? '';
  const context = el('textarea', { name: 'context', rows: 2 }); context.value = bm?.context ?? '';
  const req = bm?.required ?? 1, ct = bm?.content_type ?? 'Read';
  const formErr = el('p', { class: 'field-error', role: 'alert' });
  const submit = el('button', { type: 'submit', class: 'btn btn--primary', 'data-requires-primary': true }, isEdit ? 'Save' : 'Add');
  const form = el('form', { novalidate: true, 'aria-labelledby': 'bm-h' },
    el('h2', { id: 'bm-h', 'data-view-heading': true, tabindex: -1 }, isEdit ? 'Edit link' : 'Add link'),
    el('label', {}, 'Title', title),
    el('label', {}, 'URL (required)', url, urlErr),
    mdField(desc, 'Description'),
    mdField(context, 'Context'),
    el('fieldset', {}, el('legend', {}, 'Requirement'), radio('required', '1', req === 1, 'Required'), radio('required', '0', req === 0, 'Bonus')),
    el('fieldset', {}, el('legend', {}, 'Content type'), ...['Read', 'Watch', 'Listen', 'Participate'].map((t) => radio('content_type', t, ct === t, t))),
    formErr,
    el('div', { class: 'form-actions' }, el('button', { type: 'button', class: 'btn' }, 'Cancel'), submit));
  form.querySelector('.form-actions .btn').addEventListener('click', () => dlg.close('cancel'));
  const badScheme = (u) => /^\s*(javascript|data|vbscript|blob|file):/i.test(u);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); urlErr.textContent = ''; formErr.textContent = ''; url.setAttribute('aria-invalid', 'false');
    if (!url.value.trim() || !url.checkValidity() || badScheme(url.value)) {
      url.setAttribute('aria-invalid', 'true'); urlErr.textContent = 'Enter a valid http(s), mailto: or tel: URL.'; url.focus(); return;
    }
    const payload = { step_id: stepId, title: title.value, url: url.value, description: desc.value, context: context.value,
      required: form.required.value === '1' ? 1 : 0, content_type: form.content_type.value };
    submit.disabled = true; dlg.setAttribute('aria-busy', 'true');
    try { isEdit ? await ctx.db.updateBookmark({ id: bm.id, ...payload }) : await ctx.db.createBookmark(payload);
      dlg.close('ok'); announce(isEdit ? 'Link saved.' : 'Link added.'); }
    catch (err) { formErr.textContent = err.message || 'Could not save.'; submit.disabled = false; }
    finally { dlg.removeAttribute('aria-busy'); }
  });
  dlg.append(form); mountDialog(dlg, invoker); title.focus();
}

export function openStepEditor({ pathwayId, step = null, invoker, ctx }) {
  const isEdit = !!step, dlg = el('dialog', { class: 'pc-editor' });
  const name = el('input', { name: 'name', type: 'text', required: true, value: step?.name ?? '', 'data-focus-key': 'step-edit:name' });
  const nameErr = el('span', { class: 'field-error', role: 'alert' });
  const objective = el('textarea', { name: 'objective', rows: 3 }); objective.value = step?.objective ?? '';
  const par = el('textarea', { name: 'pause_and_reflect', rows: 2 }); par.value = step?.pause_and_reflect ?? '';
  const formErr = el('p', { class: 'field-error', role: 'alert' });
  const submit = el('button', { type: 'submit', class: 'btn btn--primary', 'data-requires-primary': true }, isEdit ? 'Save' : 'Add step');
  const form = el('form', { novalidate: true, 'aria-labelledby': 'step-h' },
    el('h2', { id: 'step-h', 'data-view-heading': true, tabindex: -1 }, isEdit ? 'Edit step' : 'Add step'),
    el('label', {}, 'Name (required)', name, nameErr),
    mdField(objective, 'Objective'),
    mdField(par, 'Pause and reflect'),
    formErr,
    el('div', { class: 'form-actions' }, el('button', { type: 'button', class: 'btn' }, 'Cancel'), submit));
  form.querySelector('.form-actions .btn').addEventListener('click', () => dlg.close('cancel'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); nameErr.textContent = ''; formErr.textContent = '';
    if (!name.value.trim()) { name.setAttribute('aria-invalid', 'true'); nameErr.textContent = 'Name is required.'; name.focus(); return; }
    const payload = { name: name.value, objective: objective.value, pause_and_reflect: par.value };
    submit.disabled = true; dlg.setAttribute('aria-busy', 'true');
    try { isEdit ? await ctx.db.updateStep({ id: step.id, ...payload }) : await ctx.db.createStep({ pathway_id: pathwayId, ...payload });
      dlg.close('ok'); announce(isEdit ? 'Step saved.' : 'Step added.'); }
    catch (err) { formErr.textContent = err.message || 'Could not save.'; submit.disabled = false; }
    finally { dlg.removeAttribute('aria-busy'); }
  });
  dlg.append(form); mountDialog(dlg, invoker); name.focus();
}

export function openPathwayEditor({ workspaceId = null, pathway = null, invoker, ctx }) {
  const isEdit = !!pathway, dlg = el('dialog', { class: 'pc-editor' });
  const name = el('input', { name: 'name', type: 'text', required: true, value: pathway?.name ?? '', 'data-focus-key': 'pw-edit:name' });
  const nameErr = el('span', { class: 'field-error', role: 'alert' });
  const description = el('textarea', { name: 'description', rows: 4 }); description.value = pathway?.description ?? '';
  const cw = el('textarea', { name: 'content_warning', rows: 2 }); cw.value = pathway?.content_warning ?? '';
  const ack = el('textarea', { name: 'acknowledgments', rows: 2 }); ack.value = pathway?.acknowledgments ?? '';

  // ---- header image (optional): staged blob, remove flag, live preview ----
  // id + a real <label for> (not the styled <span> this used to be): a file input is the one
  // control that cannot borrow a name from surrounding text, so without this a screen reader
  // announces only "button, unlabelled".
  const fileInput = el('input', { type: 'file', accept: 'image/*', name: 'header_image', id: 'pw-header-image' });
  const preview = el('img', { class: 'image-preview', alt: '', hidden: true });
  const removeBtn = el('button', { type: 'button', class: 'btn btn--danger', hidden: true }, 'Remove image');
  const imgErr = el('span', { class: 'field-error', role: 'alert' });
  let stagedBlob = null, removeFlag = false, previewUrl = null;
  const showPreview = (url) => {
    if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = url;
    if (url) { preview.src = url; preview.hidden = false; removeBtn.hidden = false; }
    else { preview.removeAttribute('src'); preview.hidden = true; removeBtn.hidden = true; }
  };
  fileInput.addEventListener('change', async () => {
    imgErr.textContent = ''; const f = fileInput.files?.[0]; if (!f) return;
    try { stagedBlob = await processImageFile(f); removeFlag = false; showPreview(URL.createObjectURL(stagedBlob)); }
    catch (err) { imgErr.textContent = err.message || 'Could not read image.'; }
  });
  removeBtn.addEventListener('click', () => { stagedBlob = null; removeFlag = true; fileInput.value = ''; showPreview(null); });
  if (isEdit && pathway.header_image_id) {
    ctx.db.getAttachment(pathway.header_image_id)
      .then((rec) => { if (rec?.bytes) showPreview(URL.createObjectURL(new Blob([rec.bytes], { type: rec.mime || 'image/jpeg' }))); })
      .catch(() => {});
  }
  const imageField = el('div', { class: 'stack' }, el('label', { class: 'field-label', for: 'pw-header-image' }, 'Header image (optional)'),
    preview, el('div', { class: 'row' }, fileInput, removeBtn), imgErr);

  const formErr = el('p', { class: 'field-error', role: 'alert' });
  const submit = el('button', { type: 'submit', class: 'btn btn--primary', 'data-requires-primary': true }, isEdit ? 'Save' : 'Create pathway');
  const form = el('form', { novalidate: true, 'aria-labelledby': 'pw-h' },
    el('h2', { id: 'pw-h', 'data-view-heading': true, tabindex: -1 }, isEdit ? 'Edit pathway' : 'New pathway'),
    el('label', {}, 'Name (required)', name, nameErr),
    mdField(description, 'Description'),
    mdField(cw, 'Content warning'),
    mdField(ack, 'Acknowledgments'),
    imageField,
    formErr,
    el('div', { class: 'form-actions' }, el('button', { type: 'button', class: 'btn' }, 'Cancel'), submit));
  form.querySelector('.form-actions .btn').addEventListener('click', () => dlg.close('cancel'));
  let createdId = null;
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); nameErr.textContent = ''; formErr.textContent = '';
    if (!name.value.trim()) { name.setAttribute('aria-invalid', 'true'); nameErr.textContent = 'Name is required.'; name.focus(); return; }
    const payload = { name: name.value, description: description.value, content_warning: cw.value, acknowledgments: ack.value };
    submit.disabled = true; dlg.setAttribute('aria-busy', 'true');
    try {
      const pid = isEdit ? (await ctx.db.updatePathway({ id: pathway.id, ...payload }), pathway.id)
                         : (createdId = (await ctx.db.createPathway({ workspace_id: workspaceId, ...payload })).id);
      if (stagedBlob) {
        const bytes = new Uint8Array(await stagedBlob.arrayBuffer());
        await ctx.db.setHeaderImage({ pathwayId: pid, mime: 'image/jpeg', bytes, byte_len: bytes.length, sha256: await sha256Hex(bytes) });
      } else if (removeFlag && isEdit) {
        await ctx.db.removeHeaderImage({ pathwayId: pid });
      }
      dlg.close('ok'); announce(isEdit ? 'Pathway saved.' : 'Pathway created.');
      if (createdId && ctx.navigate) ctx.navigate(`#/pathway/${createdId}`);
    } catch (err) { formErr.textContent = err.message || 'Could not save.'; submit.disabled = false; }
    finally { dlg.removeAttribute('aria-busy'); }
  });
  dlg.addEventListener('close', () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, { once: true });
  dlg.append(form); mountDialog(dlg, invoker); name.focus();
}

export function openWorkspaceEditor({ workspace, invoker, ctx }) {
  const dlg = el('dialog', { class: 'pc-editor' });
  const name = el('input', { name: 'org_label', type: 'text', required: true, value: workspace?.org_label ?? '', 'data-focus-key': 'ws-edit:name' });
  const nameErr = el('span', { class: 'field-error', role: 'alert' });
  const formErr = el('p', { class: 'field-error', role: 'alert' });
  const submit = el('button', { type: 'submit', class: 'btn btn--primary', 'data-requires-primary': true }, 'Save');
  const form = el('form', { novalidate: true, 'aria-labelledby': 'ws-h' },
    el('h2', { id: 'ws-h', 'data-view-heading': true, tabindex: -1 }, 'Rename workspace'),
    el('label', {}, 'Name (required)', name, nameErr),
    formErr,
    el('div', { class: 'form-actions' }, el('button', { type: 'button', class: 'btn' }, 'Cancel'), submit));
  form.querySelector('.form-actions .btn').addEventListener('click', () => dlg.close('cancel'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); nameErr.textContent = ''; formErr.textContent = '';
    if (!name.value.trim()) { name.setAttribute('aria-invalid', 'true'); nameErr.textContent = 'Name is required.'; name.focus(); return; }
    submit.disabled = true; dlg.setAttribute('aria-busy', 'true');
    try { await ctx.db.renameWorkspace({ id: workspace.id, org_label: name.value }); dlg.close('ok'); announce('Workspace renamed.'); }
    catch (err) { formErr.textContent = err.message || 'Could not save.'; submit.disabled = false; }
    finally { dlg.removeAttribute('aria-busy'); }
  });
  dlg.append(form); mountDialog(dlg, invoker); name.focus();
}

export function confirmDelete({ noun, name, onConfirm, invoker }) {
  const dlg = el('dialog', { class: 'pc-editor' },
    el('form', { method: 'dialog', 'aria-labelledby': 'del-h' },
      el('h2', { id: 'del-h', 'data-view-heading': true, tabindex: -1 }, `Delete ${noun}?`),
      el('p', {}, `“${name}” and everything inside it will be permanently deleted. This cannot be undone.`),
      el('div', { class: 'form-actions' },
        el('button', { value: 'cancel', autofocus: true, class: 'btn' }, 'Cancel'),
        el('button', { value: 'delete', class: 'btn btn--danger' }, 'Delete'))));
  document.body.append(dlg);
  dlg.addEventListener('close', async () => {
    const go = dlg.returnValue === 'delete'; dlg.remove(); invoker?.focus?.();
    if (go) { try { await onConfirm(); announce(`${noun} deleted.`); } catch (err) { announce(err.message || 'Delete failed.', { assertive: true }); } }
  }, { once: true });
  dlg.showModal();
}
