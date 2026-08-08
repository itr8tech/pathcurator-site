// src/ui/a11y.js — the shared a11y layer: ONE announcer, ONE focus capture/restore, follower read-only.
let polite, assertive, clearT;
function regions() {
  polite = polite || document.getElementById('live-polite');
  assertive = assertive || document.getElementById('live-assertive');
}
/** Announce without moving focus. assertive only for errors. */
export function announce(msg, { assertive: a = false } = {}) {
  regions();
  const elm = a ? assertive : polite;
  elm.textContent = ''; clearTimeout(clearT);
  requestAnimationFrame(() => { elm.textContent = msg; });   // toggle so identical repeats re-announce
  clearT = setTimeout(() => { elm.textContent = ''; }, 1200);
}
window.__a11y = { lastStatus: () => document.getElementById('live-polite')?.textContent,
                  lastAlert:  () => document.getElementById('live-assertive')?.textContent };

/** Route change → focus the new view heading. */
export function focusHeading(container) {
  const h = container.querySelector('[data-view-heading], h1') || container;
  if (h.tabIndex < 0 && h !== container) h.tabIndex = -1;
  h.focus({ preventScroll: false });
}

const cssEscape = (s) => (window.CSS?.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));

/** In-place re-render focus retention, keyed by data-focus-key. */
export function captureFocus(root) {
  const a = document.activeElement;
  if (!a || !root.contains(a)) return { scrollY };
  const keyed = a.closest('[data-focus-key]');
  const d = { key: keyed?.getAttribute('data-focus-key') || null, scrollY };
  if ('selectionStart' in a && a.selectionStart != null) { d.selStart = a.selectionStart; d.selEnd = a.selectionEnd; }
  return d;
}
export function restoreFocus(root, d) {
  if (!d) return;
  let t = d.key ? root.querySelector(`[data-focus-key="${cssEscape(d.key)}"]`) : null;
  const unusable = (n) => !n || n.disabled || n.getAttribute?.('aria-disabled') === 'true';
  if (t && unusable(t)) {   // moved to a boundary → the just-clicked arrow is now disabled; focus a nearby usable control
    const item = t.closest('[data-id]');
    t = item?.querySelector('button:not([disabled]):not([aria-disabled="true"]), a[href]') || null;
  }
  if (!t) { t = root.querySelector('[data-view-heading], h1'); if (t && d.key) announce('Item removed.'); }
  if (t) {
    if (t.tabIndex < 0 && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) t.tabIndex = -1;
    t.focus({ preventScroll: true });
    if (d.selStart != null && 'setSelectionRange' in t) { try { t.setSelectionRange(d.selStart, d.selEnd); } catch {} }
  }
  if (typeof d.scrollY === 'number') scrollTo({ top: d.scrollY });
}

/** Follower read-only: ONE attribute (data-requires-primary), ONE role location (body[data-role]). */
export function applyReadOnly(root, readOnly) {
  for (const elm of root.querySelectorAll('[data-requires-primary]')) {
    if ('disabled' in elm && elm.tagName !== 'A') elm.disabled = readOnly;
    else { elm.setAttribute('aria-disabled', String(readOnly)); if (readOnly) elm.tabIndex = -1; else elm.removeAttribute('tabindex'); }
  }
}
// Click-guard for aria-disabled links on followers.
addEventListener('click', (e) => {
  if (document.body.dataset.role !== 'follower') return;
  const t = e.target.closest?.('a[data-requires-primary], [aria-disabled="true"]');
  if (t) { e.preventDefault(); e.stopPropagation(); announce('Read-only in this tab.'); }
}, true);
