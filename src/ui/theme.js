// src/ui/theme.js — ONE theme state machine (localStorage authoritative; settings mirror).
import { db } from '/src/data/db.js';
const KEY = 'pc-theme';
export const current = () =>
  document.documentElement.getAttribute('data-theme') ||
  (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

function apply(t) { document.documentElement.setAttribute('data-theme', t); }
export function toggle() {
  const t = current() === 'dark' ? 'light' : 'dark';
  apply(t);
  try { localStorage.setItem(KEY, t); } catch {}
  if (db.isPrimary() && typeof db.setSetting === 'function') db.setSetting('theme', t).catch(() => {});
  return t;
}
// After db.ready(): reconcile durable settings mirror ↔ localStorage. Local explicit choice wins.
export async function reconcile() {
  let explicit = null; try { explicit = localStorage.getItem(KEY); } catch {}
  let stored = null;    try { stored = await db.getSetting('theme'); } catch {}
  if (explicit === 'light' || explicit === 'dark') {
    if (stored !== explicit && db.isPrimary()) db.setSetting('theme', explicit).catch(() => {});
  } else if (stored === 'light' || stored === 'dark') {
    apply(stored); try { localStorage.setItem(KEY, stored); } catch {}
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    try { if (localStorage.getItem(KEY)) return; } catch {}
    document.documentElement.removeAttribute('data-theme');
  });
  addEventListener('storage', (e) => { if (e.key === KEY && (e.newValue === 'light' || e.newValue === 'dark')) apply(e.newValue); });
}
