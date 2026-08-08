// add/add.js — the DB-free capture endpoint served at /add/. Parses a GET capture (bookmarklet /
// manual paste / a Web-Share redirect) and appends it to the durable IndexedDB capture_outbox; the
// PRIMARY app tab drains it into the inbox. Imports ONLY the outbox queue + DOM helpers — no SQLite,
// no app shell, no worker. Runs in any tab, offline (precached by the service worker).
import { el, clear } from '/src/ui/dom.js';
import { append } from '/src/data/capture-outbox.js';

const view = document.getElementById('add-view');
const live = document.getElementById('live-polite');
const params = new URLSearchParams(location.search);

const announce = (m) => { if (live) { live.textContent = ''; requestAnimationFrame(() => { live.textContent = m; }); } };
const heading = (t) => el('h1', { 'data-view-heading': true, tabindex: -1 }, t);
const focusHeading = () => view.querySelector('[data-view-heading]')?.focus();

// A share/bookmarklet POPUP can close itself after saving; a tab the user navigated shouldn't.
function maybeAutoClose() {
  if (window.opener || params.get('popup') === '1') setTimeout(() => { try { window.close(); } catch { /* not a popup */ } }, 1200);
}

function renderSaved({ autoClose = false } = {}) {
  clear(view).append(el('section', { class: 'add-card card' },
    heading('✓ Saved to your inbox'),
    el('p', { class: 'muted' }, 'You can sort it into a pathway whenever you like.'),
    el('div', { class: 'form-actions' },
      el('a', { class: 'btn', href: '/' }, 'Close'),
      el('a', { class: 'btn btn--primary', href: '/#/inbox' }, 'Open inbox'))));
  view.removeAttribute('aria-busy'); focusHeading(); announce('Saved to your inbox.');
  if (autoClose) maybeAutoClose();
}

function renderError() {
  clear(view).append(el('section', { class: 'add-card card' },
    heading('Couldn’t save'),
    el('p', { role: 'alert' }, 'Your browser blocked local storage — this often means a private window. Open PathCurator normally and try again.'),
    el('div', { class: 'form-actions' }, el('a', { class: 'btn btn--primary', href: '/' }, 'Open PathCurator'))));
  view.removeAttribute('aria-busy'); focusHeading();
}

async function save(payload) {
  try { await append(payload); renderSaved({ autoClose: true }); }
  catch { renderError(); }
}

function renderManualForm(prefill = {}) {
  const url = el('input', { name: 'url', type: 'url', required: true, autocomplete: 'off', placeholder: 'https://…', value: prefill.url || '' });
  const title = el('input', { name: 'title', type: 'text', autocomplete: 'off', value: prefill.title || '' });
  const note = el('textarea', { name: 'note', rows: 2 });
  const ct = el('select', { name: 'content_type' },
    ...['Read', 'Watch', 'Listen', 'Participate'].map((v) => el('option', { value: v, selected: v === (prefill.contentType || 'Read') }, v)));
  const err = el('p', { class: 'field-error', role: 'alert' });

  const form = el('form', { class: 'add-form', novalidate: true },
    heading('Add to your inbox'),
    el('label', {}, 'Link', url),
    el('label', {}, 'Title (optional)', title),
    el('label', {}, 'Note (optional)', note),
    el('label', {}, 'Type', ct),
    err,
    el('div', { class: 'form-actions' },
      el('a', { class: 'btn', href: '/' }, 'Cancel'),
      el('button', { type: 'submit', class: 'btn btn--primary' }, 'Save')));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const u = url.value.trim();
    if (!u) { err.textContent = 'A link is required.'; url.focus(); return; }
    save({ ref: `manual:${crypto.randomUUID()}`, url: u, title: title.value.trim() || null, note: note.value.trim() || null,
           description: null, imageUrl: null, contentType: ct.value, source: 'manual', capturedAt: Date.now() });
  });

  clear(view).append(el('section', { class: 'add-card card' }, form));
  view.removeAttribute('aria-busy'); url.focus();
}

// ---- entry ----
// P8: `source` is allowlisted to the schema enum; `ref` is accepted when well-formed so callers
// (the extension) get REAL idempotency — a reloaded/double-opened capture page re-appends the SAME
// ref and the outbox/inbox dedupe instead of duplicating. Malformed values → safe defaults.
const SOURCES = new Set(['extension', 'bookmarklet', 'share-target', 'protocol', 'manual']);
const REF_RE = /^(ext|bookmarklet|share|manual):[A-Za-z0-9-]{1,64}$/;
if (params.get('shared') === '1') {
  renderSaved({ autoClose: false });                 // the Web-Share SW already appended — confirm only
} else {
  const url = (params.get('url') || '').trim();
  const title = params.get('title');
  const text = params.get('text') || params.get('description');
  const note = params.get('note');
  const source = SOURCES.has(params.get('source')) ? params.get('source') : 'bookmarklet';
  const refParam = params.get('ref');
  const ref = REF_RE.test(refParam || '') ? refParam : `bookmarklet:${crypto.randomUUID()}`;
  if (!url) {
    renderManualForm({ title });                     // empty url → manual form (never an error)
  } else {
    save({ ref, url, title: title || null, note: note || null,
           description: text || null, imageUrl: null, contentType: 'Read', source, capturedAt: Date.now() });
  }
}
