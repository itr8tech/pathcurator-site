// src/ui/toast.js — a VISIBLE transient notice. announce() (a11y.js) only feeds the hidden
// screen-reader live region, so actions like Pull looked like they did nothing to sighted users.
// The toast carries role="status", so screen readers hear it too — callers should use toast() OR
// announce(), not both, to avoid double announcements.
import { el } from './dom.js';

let current = null;
export function toast(message, { duration = 4500 } = {}) {
  current?.remove();
  const t = el('div', { class: 'toast', role: 'status' }, message);
  document.body.append(t);
  current = t;
  setTimeout(() => { if (t.isConnected) t.remove(); if (current === t) current = null; }, duration);
}
