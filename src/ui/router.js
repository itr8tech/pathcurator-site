// src/ui/router.js — hash router: match, lifecycle, change re-render, focus retention, reorder gate.
import * as a11y from './a11y.js';
import { clear } from './dom.js';

// Create/edit is in-view <dialog> (editors.js), not routes → just two views + the notfound fallback.
const routes = [
  { path: '',            load: () => import('./views/dashboard.js') },
  { path: 'inbox',       load: () => import('./views/inbox.js') },
  { path: 'audit',       load: () => import('./views/audit.js') },
  { path: 'help',        load: () => import('./views/help.js') },
  { path: 'help/:topic', load: () => import('./views/help.js') },
  { path: 'sync',        load: () => import('./views/sync.js') },
  { path: 'pathway/:id', load: () => import('./views/pathway.js') },
  { path: 'merge/:wsId', load: () => import('./views/merge.js') },
].map((r) => ({ ...r, ...compile(r.path) }));

function compile(path) {
  const names = [];
  const rx = new RegExp('^' + path.replace(/:[^/]+/g, (m) => { names.push(m.slice(1)); return '([^/]+)'; }) + '$');
  return { rx, names };
}
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [p, q = ''] = raw.split('?');
  return { path: decodeURIComponent(p.replace(/\/+$/, '')), query: new URLSearchParams(q) };
}
function match(path) {
  for (const r of routes) {
    const m = r.rx.exec(path);
    if (m) return { route: r, params: Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

let outlet, ctx, shell, current = null, currentAbort = null, navToken = 0;
let suspended = false, pendingEvt = null, lastEvt = null, rerenderRunning = false, rerenderPending = false;

export const currentSignal = () => currentAbort?.signal;
export function start(opts) {
  outlet = document.getElementById('view'); shell = opts.shell; ctx = opts.ctx;
  addEventListener('hashchange', () => route());
  return route();
}
export function navigate(hash) {
  const t = hash.startsWith('#') ? hash : '#' + (hash.startsWith('/') ? hash : '/' + hash);
  if (location.hash === t) return route();   // same hash → force remount
  location.hash = t;                          // → hashchange → route()
}

async function route() {
  const token = ++navToken;
  const { path, query } = parseHash();
  const hit = match(path);
  const load = hit ? hit.route.load : () => import('./views/notfound.js');
  const params = { ...(hit?.params || {}), query };

  if (current) { try { current.destroy?.(); } catch {} current = null; }
  if (currentAbort) currentAbort.abort();
  currentAbort = new AbortController();

  shell.setBusy(true);
  clear(outlet).append(shell.skeleton());

  let mod;
  try { mod = await load(); } catch (e) { if (token !== navToken) return; return fail('This page failed to load.', e); }
  if (token !== navToken) return;

  clear(outlet);
  let controller;
  try { controller = await mod.default(outlet, params, ctx); }
  catch (e) { if (token !== navToken) return; return fail('This view could not be rendered.', e); }
  if (token !== navToken) { controller?.destroy?.(); return; }

  current = controller;
  shell.setBusy(false);
  a11y.focusHeading(outlet);
  const title = controller.title || 'PathCurator';
  document.title = title === 'PathCurator' ? title : `${title} · PathCurator`;
  a11y.announce(title);
}
function fail(msg, err) {
  console.error('[router]', err); shell.setBusy(false);
  clear(outlet).append(shell.errorPane(msg)); a11y.announce(msg, { assertive: true });
}

// ── coordinator change → re-render active view WITH focus retention ──
// Coalescing WITH a trailing render: while a refresh is queued or in flight, further changes don't
// each spawn a render — but the most recent one is remembered and run once the current render
// finishes, so the view can never settle on stale data. (The earlier version dropped any change
// that landed mid-render, which could leave e.g. the sync chip showing a stale count.)
export function handleChange(evt) {
  if (evt.type === 'promoted' || evt.type === 'primary-up') { shell.setRole(ctx.db.role(), ctx.db.isPrimary()); }
  if (suspended) { pendingEvt = evt; return; }      // don't yank DOM mid-drag
  if (!current) return;
  lastEvt = evt;
  if (rerenderRunning) { rerenderPending = true; return; }   // coalesce → the trailing render catches up
  runRerender();
}
function runRerender() {
  rerenderRunning = true;
  rerenderPending = false;
  queueMicrotask(async () => {
    try { await rerender(lastEvt); }
    finally {
      rerenderRunning = false;
      if (rerenderPending && current) runRerender();   // a change landed mid-render → run exactly one more
    }
  });
}
async function rerender(evt) {
  if (!current) return;
  const token = navToken;
  if (typeof current.refresh !== 'function') return;   // transient views (merge, notfound) don't self-refresh
  const desc = a11y.captureFocus(outlet);           // capture BEFORE
  shell.setBusy(true);
  try { await current.refresh(evt); } catch (e) { console.error('[router] refresh', e); }
  finally { if (token === navToken) { shell.setBusy(false); a11y.restoreFocus(outlet, desc); if (!evt.local) a11y.announce('Content updated.'); } }
}

// reorder gate (reorder.js calls these around an active pointer/keyboard drag)
export function suspendRefresh() { suspended = true; }
export function resumeRefresh() { suspended = false; if (pendingEvt) { const e = pendingEvt; pendingEvt = null; handleChange(e); } }
