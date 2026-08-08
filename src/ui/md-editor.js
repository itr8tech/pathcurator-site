// src/ui/md-editor.js — markdown enhancement for a plain textarea: Write ⁄ Preview tabs, a small
// formatting toolbar, and keyboard shortcuts (Ctrl/⌘ B · I · K). The preview renders through the
// app's OWN sanitizer (renderMarkdown) — the locked constraint from the deferred-item note — so
// what you preview is exactly what every view (and the published page) will render. The original
// textarea element is kept as-is (same name/value), so the editor forms need no other changes.
import { el } from './dom.js';
import { renderMarkdown } from './markdown.js';

const fire = (ta) => ta.dispatchEvent(new Event('input', { bubbles: true }));

function surround(ta, pre, post, placeholder) {
  const s = ta.selectionStart ?? 0, e = ta.selectionEnd ?? 0, v = ta.value;
  const sel = v.slice(s, e) || placeholder;
  ta.value = v.slice(0, s) + pre + sel + post + v.slice(e);
  ta.focus();
  ta.setSelectionRange(s + pre.length, s + pre.length + sel.length);
  fire(ta);
}

function insertLink(ta) {
  const s = ta.selectionStart ?? 0, e = ta.selectionEnd ?? 0, v = ta.value;
  const sel = v.slice(s, e) || 'link text';
  ta.value = `${v.slice(0, s)}[${sel}](https://)${v.slice(e)}`;
  ta.focus();
  const u = s + sel.length + 3;                            // select the "https://" for overtyping
  ta.setSelectionRange(u, u + 8);
  fire(ta);
}

function linePrefix(ta, prefix, numbered = false) {
  const v = ta.value;
  const s = ta.selectionStart ?? 0, e = ta.selectionEnd ?? 0;
  const ls = v.lastIndexOf('\n', s - 1) + 1;
  let le = v.indexOf('\n', e); if (le === -1) le = v.length;
  const block = v.slice(ls, le).split('\n').map((l, i) => (numbered ? `${i + 1}. ` : prefix) + l).join('\n');
  ta.value = v.slice(0, ls) + block + v.slice(le);
  ta.focus();
  ta.setSelectionRange(ls, ls + block.length);
  fire(ta);
}

// Wrap an existing textarea, with its own label ABOVE the widget (label[for], not nesting — a
// wrapping <label> would fold the toolbar buttons into accessible-name computation and garble
// what screen readers announce for every control). The textarea stays the live form field.
let idSeq = 0;
export function mdField(ta, labelText) {
  ta.classList.add('md-input');
  if (!ta.id) ta.id = `md-input-${++idSeq}`;
  const tool = (label, aria, fn) => {
    const b = el('button', { type: 'button', class: 'md-tool', 'aria-label': aria, title: aria }, label);
    b.addEventListener('click', fn);
    return b;
  };
  const tools = el('span', { class: 'md-tools' },
    tool(el('strong', {}, 'B'), 'Bold (Ctrl/⌘ B)', () => surround(ta, '**', '**', 'bold text')),
    tool(el('em', {}, 'I'), 'Italic (Ctrl/⌘ I)', () => surround(ta, '*', '*', 'italic text')),
    tool('🔗', 'Insert link (Ctrl/⌘ K)', () => insertLink(ta)),
    tool('•', 'Bulleted list', () => linePrefix(ta, '- ')),
    tool('1.', 'Numbered list', () => linePrefix(ta, '', true)),
    tool('❝', 'Quote', () => linePrefix(ta, '> ')));

  const preview = el('div', { class: 'md-preview prose', hidden: true });
  const writeTab = el('button', { type: 'button', class: 'md-tab', 'aria-pressed': 'true' }, 'Write');
  const previewTab = el('button', { type: 'button', class: 'md-tab', 'aria-pressed': 'false' }, 'Preview');
  function show(previewing) {
    preview.hidden = !previewing;
    ta.hidden = previewing;
    tools.hidden = previewing;
    writeTab.setAttribute('aria-pressed', String(!previewing));
    previewTab.setAttribute('aria-pressed', String(previewing));
    if (previewing) preview.replaceChildren(ta.value.trim() ? renderMarkdown(ta.value) : el('p', { class: 'muted' }, 'Nothing to preview.'));
    else ta.focus();
  }
  writeTab.addEventListener('click', () => show(false));
  previewTab.addEventListener('click', () => show(true));

  ta.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'b') { e.preventDefault(); surround(ta, '**', '**', 'bold text'); }
    else if (k === 'i') { e.preventDefault(); surround(ta, '*', '*', 'italic text'); }
    else if (k === 'k') { e.preventDefault(); insertLink(ta); }
  });

  return el('div', { class: 'md-field' },
    el('label', { class: 'field-label', for: ta.id }, labelText),
    el('div', { class: 'md-editor' },
      el('div', { class: 'md-bar' },
        el('span', { class: 'md-tabs', role: 'group', 'aria-label': 'Write or preview' }, writeTab, previewTab),
        tools),
      ta, preview));
}
