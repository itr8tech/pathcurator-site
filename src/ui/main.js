// src/ui/main.js — boot: db.ready → theme → shell → router.
import { db } from '/src/data/db.js';
import * as shellMod from './shell.js';
import * as router from './router.js';
import * as theme from './theme.js';
import { announce, applyReadOnly } from './a11y.js';
import { renderMarkdown, renderMarkdownInto, sanitizeHtml, safeUrl } from './markdown.js';
import { createGitHubClient } from '/src/data/github.js';
import { createSync } from '/src/data/sync.js';
import { mountSyncBadge } from './sync-indicator.js';
import { mountInboxBadge } from './inbox-badge.js';
import * as secrets from '/src/data/secrets.js';
import * as captureOutbox from '/src/data/capture-outbox.js';

function missingCapabilities() {
  const missing = [];
  if (typeof WebAssembly === 'undefined') missing.push('WebAssembly');
  if (typeof Worker === 'undefined') missing.push('Web Workers');
  if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') missing.push('OPFS');
  if (!self.isSecureContext) missing.push('secure-context');
  return missing;
}
function showCapability(shell, kind, meta) {
  const view = document.getElementById('view');
  view.setAttribute('aria-busy', 'false');
  view.replaceChildren(shell.capabilityScreen({ kind, detail: meta?.error }));
  view.querySelector('[data-view-heading]')?.focus?.();
  shell.setRole('pending', false);                 // hide the primary/follower banner
  window.__pc = { ready: false, capability: kind, ...meta };
}

// Register the PWA service worker (precache + offline). Non-fatal and primary-agnostic — offline
// support is an enhancement; the app runs without it. The SW never opens the DB.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !self.isSecureContext) return;
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    // Update notice — only when an OLD version controls this page (not on first install). sw.js
    // skipWaiting()s, so once the fresh worker activates, one reload gets the new (network-first)
    // modules; no more guessing whether a deploy has landed.
    if (!navigator.serviceWorker.controller) return;
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'activated') showUpdateNotice(); });
    });
  }).catch((e) => console.warn('[sw] register failed:', e));
}
function showUpdateNotice() {
  if (document.getElementById('sw-update')) return;
  const reload = document.createElement('button');
  reload.type = 'button'; reload.className = 'btn btn--sm'; reload.textContent = 'Reload';
  reload.addEventListener('click', () => location.reload());
  const note = document.createElement('div');
  note.id = 'sw-update'; note.className = 'update-notice'; note.setAttribute('role', 'status');
  note.append('A new version of PathCurator is available. ', reload);
  document.body.append(note);
}

async function boot() {
  // CLICKJACKING: frame-guard.js already hid the document and flagged a framed load. Explain and
  // stop — no database, no service worker, and above all no PAT vault inside a hostile frame.
  if (window.__pcFramed) {
    // Strip the chrome first. A framed load is a REFUSAL NOTICE, not the app: leaving the header
    // nav and theme toggle on screen would both dress the attacker's page up as a working
    // PathCurator and leave real controls sitting under their invisible overlay. This also means
    // shell.init() can't run (it binds those elements), so the screen is built directly.
    for (const sel of ['.app-header', '.app-footer', '#role-banner', '.skip-link']) document.querySelector(sel)?.remove();
    const view = document.getElementById('view');
    view.setAttribute('aria-busy', 'false');
    view.replaceChildren(shellMod.capabilityScreen({ kind: 'framed' }));
    document.documentElement.style.display = '';        // the guard hid it; the notice needs to show
    view.querySelector('[data-view-heading]')?.focus?.();
    window.__pc = { ready: false, capability: 'framed' };
    return;
  }
  registerServiceWorker();
  // Durability (O11): ask the browser to shield OPFS from storage-pressure eviction (Safari's
  // ~7-day ITP eviction especially). Best-effort — denial is fine; sync + export are the backstop.
  navigator.storage?.persisted?.().then((p) => p || navigator.storage.persist?.()).catch(() => {});
  const shell = shellMod.init();
  shell.setRole('pending', false);

  const ctx = {
    db, isPrimary: () => db.isPrimary(), navigate: router.navigate, announce,
    md: { renderMarkdown, renderMarkdownInto, sanitizeHtml, safeUrl }, signal: () => router.currentSignal(),
  };

  // Static capability check, surfaced by LIKELIEST CAUSE, not by feature list. An insecure origin
  // (plain http:// on a LAN host) disables everything at once — diagnose it first, or the screen
  // blames "old browser" for what is really a missing https.
  const missing = missingCapabilities();
  if (missing.length) {
    const kind = missing.includes('secure-context') ? 'insecure'
      : (missing.includes('WebAssembly') || missing.includes('Web Workers')) ? 'oldbrowser'
      : 'storage';
    showCapability(shell, kind, { missing });
    return;
  }

  let r;
  try { r = await db.ready(); }
  catch (e) {
    const msg = e.message || '';
    // Schema problems get their OWN screens. Falling through to the storage/oldbrowser banners
    // would tell the user their browser can't store data, when in fact the data is intact and the
    // problem is the code: too old for the database, or an upgrade that rolled back.
    if (msg.includes('SCHEMA_NEWER')) { showCapability(shell, 'schema-newer', { error: msg }); return; }
    if (msg.includes('migration to schema')) { showCapability(shell, 'migration-failed', { error: msg }); return; }
    // Runtime failure (e.g. OPFS disabled in a private window → sahpool can't acquire) → storage banner.
    const storage = /opfs|sahpool|storage|directory|quota|acquire|filesystem/i.test(msg);
    showCapability(shell, storage ? 'storage' : 'oldbrowser', { error: msg });
    return;
  }

  shell.setRole(r.role, r.isPrimary);
  applyReadOnly(document.body, !r.isPrimary);
  await theme.reconcile();
  shell.paintThemeToggle();               // reconcile may have flipped the theme → repaint sun/moon

  // NO production seed: an empty database boots empty; content arrives by creating a workspace or
  // connecting a repo and pulling. The converted fixture under /seed is TEST-ONLY — specs opt in by
  // setting window.__pcSeed = ['hoil','redi'] via addInitScript (primary + empty DB only).
  if (window.__pcSeed && r.isPrimary && r.counts.pathways === 0) {
    try {
      for (const ws of window.__pcSeed) {
        const manifest = await (await fetch(`/seed/${ws}/manifest.json`)).json();
        const pathways = [];
        for (const e of manifest.pathways) pathways.push(await (await fetch(`/seed/${ws}/${e.file}`)).json());
        await db.importWorkspace({ workspace: ws, orgLabel: manifest.orgLabel, pathways });
      }
    } catch (e) { console.warn('[seed] skipped:', e); }
  }

  // GitHub sync (P3). Tests inject an in-memory backend via window.__pcGitHubFactory (awaiting a
  // ready hook first); production falls back to the real client. Secrets + fetch stay main-thread.
  if (window.__pcGitHubReady) { try { await window.__pcGitHubReady; } catch (e) { console.warn('[sync] github hook failed:', e); } }
  const githubFactory = window.__pcGitHubFactory || createGitHubClient;
  ctx.githubFactory = githubFactory;
  const sync = createSync({
    db, secrets,
    makeClient: (ws, token) => githubFactory({ owner: ws.owner, repo: ws.repo, branch: ws.branch || 'main', path: ws.path || '', token }),
    isPrimary: () => db.isPrimary(),
    // P10 1b: published SCORM packages ride commits. Injected so the data layer never imports UI
    // modules; the builder honors the curator's stored attribution choice.
    buildScormPackage: async (pathwayId) => {
      const { buildPathwayScorm } = await import('./publish-scorm.js');
      const attribution = (await db.getSetting('publish_attribution')) === '1';
      return buildPathwayScorm(db, { id: pathwayId, attribution });
    },
  });
  ctx.sync = sync;
  window.__pcSync = sync;                 // test seam (parity with window.__pc / window.__P2)
  mountSyncBadge(sync);                    // global header badge on the "Sync" nav link
  mountInboxBadge(db);                      // unsorted-count badge on the "Inbox" nav link
  sync.init().catch((e) => console.warn('[sync] init:', e));
  if (db.isPrimary()) sync.startTimers();

  // Capture drain (PRIMARY-only; a follower call no-ops). Triggered on: becoming primary (here for
  // the fast-path primary + in the promoted branch below), a capture signal from the /add page, and
  // foreground (catches a signal missed while backgrounded, and the SW-can't-postMessage case).
  const drain = () => db.drainCaptureOutbox().catch(() => {});
  if (db.isPrimary()) drain();
  captureOutbox.onSignal(drain);
  window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') drain(); });
  window.addEventListener('focus', drain);

  // Last-resort guard against losing un-pushed work when the primary tab closes.
  window.addEventListener('beforeunload', (e) => {
    if (db.isPrimary() && sync.totalUncommitted() > 0) { e.preventDefault(); e.returnValue = ''; }
  });

  db.onChange((evt) => {
    if (evt.type === 'promoted' || evt.type === 'primary-up') { shell.setRole(db.role(), db.isPrimary()); applyReadOnly(document.body, !db.isPrimary()); sync.startTimers(); if (db.isPrimary()) drain(); }
    router.handleChange(evt);
    sync.handleChange(evt);
    if (window.__pc) window.__pc.changes = (window.__pc.changes || 0) + 1;
  });

  await router.start({ shell, ctx });

  window.__pc = { ready: true, role: db.role(), isPrimary: db.isPrimary(), changes: 0 }; // parity w/ P1 harness
  window.__P2 = { ok: true, route: () => location.hash };
}
boot();
