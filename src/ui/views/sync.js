// src/ui/views/sync.js — #/sync cross-workspace overview, designed to be self-explanatory: what
// sync IS (intro), what happened (latest repo commit + this browser's last commit/pull), what's
// waiting (changed pathways), and what to do about it (state-specific guidance under the buttons)
// — the docs shouldn't be required reading to use this screen. Facts that need the network (the
// repo's HEAD commit) fill in async after paint and never block or break the view.
import { el, clear } from '../dom.js';
import { syncRow, syncChip } from '../sync-indicator.js';
import { openConnectRepo } from '../connect.js';

function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 90000) return 'just now';
  if (d < 3600000) return `${Math.max(1, Math.floor(d / 60000))}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  if (d < 30 * 86400000) return `${Math.floor(d / 86400000)}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}
const firstLine = (s) => String(s || '').split('\n', 1)[0].slice(0, 120);

// The last commit/pull performed from THIS browser (recorded by sync at action time).
function lastActionText(a) {
  if (!a) return 'No commits or pulls from this browser yet.';
  const when = relTime(a.at);
  if (a.type === 'commit') {
    const what = [a.changed ? `${a.changed} pathway${a.changed === 1 ? '' : 's'}` : null,
      a.deleted ? `${a.deleted} deleted` : null].filter(Boolean).join(', ');
    return `Committed${what ? ` ${what}` : ''} — “${firstLine(a.message)}” · ${when}`;
  }
  return a.upToDate ? `Pulled — already up to date · ${when}` : `Pulled and merged · ${when}`;
}

// One state-appropriate sentence that says what the buttons DO and which one to reach for.
function hintText(st) {
  if (st.remoteAhead) return 'The repository has commits you haven’t pulled, so committing is paused. '
    + 'Pull & review shows you every incoming change before it’s applied — nothing is overwritten silently.';
  if (st.state === 'never-committed') return 'Never committed: the repository doesn’t have this workspace’s content yet. '
    + 'Commit publishes everything here as the shared starting point.';
  if (st.dirty) return 'Commit sends the changes above to the repository so teammates and your other devices can pull them. '
    + 'Review… shows exactly what you changed — and can revert it. Nothing leaves this browser until you commit.';
  if (st.auditDirty) return 'Your audit decisions (verified links, pins, exemptions) commit like content — '
    + 'so the weekly checker and your other devices respect them.';
  return 'Everything here matches your last commit. Pull any time to pick up what others committed; '
    + 'Auto-commit keeps small edits flowing to the repo without the dialog.';
}

export default async function mount(container, params, ctx) {
  const root = el('div', { class: 'view-content' });
  container.append(root);
  let unsub = () => {};
  const controller = { title: 'Sync', refresh, destroy() { unsub(); } };
  async function refresh() {
    const [workspaces, pathways] = await Promise.all([ctx.db.getWorkspaces(), ctx.db.listPathways()]);
    const nameById = new Map(pathways.map((p) => [p.id, p.name]));
    const primary = ctx.isPrimary();
    const statuses = {};
    if (ctx.sync) await Promise.all(workspaces.map(async (w) => { statuses[w.id] = await ctx.sync._computeStatus(w.id); }));
    const connected = workspaces.filter((w) => w.owner && w.repo);
    const total = Object.values(statuses).reduce((n, s) => n + (s.uncommittedCount || 0), 0);
    const conflicts = Object.values(statuses).filter((s) => s.remoteAhead);

    clear(root);
    root.append(el('h1', { 'data-view-heading': true, tabindex: -1 }, 'Sync'),
      el('p', { class: 'muted sync-intro' },
        'A connected workspace mirrors a GitHub repository: the repo is the shared, backed-up copy; ',
        'this browser holds your working copy. ', el('strong', {}, 'Commit'), ' publishes your local changes. ',
        el('strong', {}, 'Pull'), ' fetches what others committed and merges it — conflicts are always shown, never overwritten.'));

    if (conflicts.length) root.append(el('p', { class: 'sync-summary sync-summary--danger', role: 'status' },
      `${conflicts.length} workspace${conflicts.length === 1 ? '' : 's'} with a sync conflict — pull to review.`));
    else if (total) root.append(el('p', { class: 'sync-summary', role: 'status' },
      `${total} uncommitted change${total === 1 ? '' : 's'} across ${connected.length} connected workspace${connected.length === 1 ? '' : 's'}.`));
    else if (Object.values(statuses).some((s) => s.auditDirty)) root.append(el('p', { class: 'sync-summary', role: 'status' },
      'Audit changes pending (overrides or exemptions) — commit to share them with your other devices and the audit workflow.'));
    else root.append(el('p', { class: 'sync-summary sync-summary--ok', role: 'status' },
      connected.length ? 'All connected workspaces are in sync.' : 'No workspaces are connected to a repository yet.'));

    if (!workspaces.length) {
      root.append(el('p', { class: 'muted' }, 'No workspaces yet — create one from the dashboard.'),
        el('p', {}, el('a', { class: 'btn', href: '#/' }, 'Back to dashboard')));
      return;
    }

    const list = el('div', { class: 'sync-list' });
    for (const ws of workspaces) {
      const st = statuses[ws.id] || { state: 'disconnected', uncommittedCount: 0 };
      const conn = !!(ws.owner && ws.repo);
      const card = el('section', { class: 'sync-ws-card', 'aria-labelledby': `syncws-${ws.id}`,
        style: ws.colour ? `--org-accent:${ws.colour}` : null });
      card.append(el('header', {},
        el('h2', { id: `syncws-${ws.id}` }, ws.org_label),
        conn
          ? el('a', { class: 'ws-conn is-connected', href: `https://github.com/${ws.owner}/${ws.repo}`,
            target: '_blank', rel: 'noopener noreferrer' }, `${ws.owner}/${ws.repo} ↗`)
          : el('span', { class: 'ws-conn is-disconnected' }, 'Not connected')));

      if (!conn) {
        card.append(el('p', { class: 'sync-hint muted' },
          'This workspace lives only in this browser. Connecting a repository adds an off-device backup, '
          + 'sync between your devices, teammate collaboration, and the weekly link audit.'));
        if (primary) {
          const connect = el('button', { type: 'button', class: 'btn btn--sm', 'data-requires-primary': true }, 'Connect repo…');
          connect.addEventListener('click', (ev) => openConnectRepo({ workspace: ws, invoker: ev.currentTarget, ctx }));
          card.append(el('div', { class: 'sync-row' }, syncChip(st, ws.id), connect));
        } else card.append(el('div', { class: 'sync-row' }, syncChip(st, ws.id)));
        list.append(card);
        continue;
      }

      // ---- the facts: repo HEAD (async fill), this browser's last action, what's waiting ----
      const remoteDd = el('dd', { 'data-remote-head': ws.id }, primary ? 'checking…' : '—');
      const facts = el('dl', { class: 'sync-facts' },
        el('div', {}, el('dt', {}, 'Latest commit in the repo'), remoteDd),
        el('div', {}, el('dt', {}, 'Last synced from this browser'),
          el('dd', {}, lastActionText(await ctx.db.getSetting(`sync_last_action:${ws.id}`)
            .then((v) => { try { return JSON.parse(v || 'null'); } catch { return null; } })))));
      const changed = (st.changedPathwayIds || []).map((id) => nameById.get(id)).filter(Boolean);
      if (changed.length || st.removedPathwayIds?.length || st.auditDirty) {
        const bits = [];
        if (changed.length) bits.push(`Changed: ${changed.join(', ')}`);
        if (st.removedPathwayIds?.length) bits.push(`${st.removedPathwayIds.length} deleted pathway${st.removedPathwayIds.length === 1 ? '' : 's'}`);
        if (st.auditDirty) bits.push('audit changes (overrides / exemptions)');
        facts.append(el('div', {}, el('dt', {}, 'Waiting to commit'),
          el('dd', { class: 'sync-detail' }, bits.join(' · '))));
      }
      card.append(facts);

      if (primary) {
        card.append(syncRow(ws, st, ctx));
        card.append(el('p', { class: 'sync-hint muted' }, hintText(st)));
        // Async fill-in: the repo's HEAD commit — message, author, when, and whether it's pulled.
        ctx.sync.remoteHead(ws.id).then((h) => {
          if (!remoteDd.isConnected) return;
          if (!h) { remoteDd.textContent = 'empty repository — nothing committed yet'; return; }
          clear(remoteDd);
          remoteDd.append(`“${firstLine(h.message)}”`,
            el('span', { class: 'muted' }, ` — ${h.author || 'unknown'}, ${h.date ? relTime(Date.parse(h.date)) : '?'} · `),
            el('a', { href: h.url, target: '_blank', rel: 'noopener noreferrer' }, h.sha.slice(0, 7)),
            el('span', { class: h.pulled ? 'muted' : 'sync-facts__new' },
              h.pulled ? ' · pulled into this browser ✓' : ' · not pulled here yet'));
        }).catch(() => { if (remoteDd.isConnected) remoteDd.textContent = 'couldn’t reach GitHub (offline, or the token expired)'; });
      } else {
        card.append(el('div', { class: 'sync-row' }, syncChip(st, ws.id)),
          el('p', { class: 'sync-hint muted' }, 'Read-only in this tab — another PathCurator tab is in charge of syncing.'));
      }
      list.append(card);
    }
    root.append(list);
  }

  // Live-update when the global conflict state flips. Ordinary count changes (edit/commit/pull)
  // carry a DB change event the router already re-renders on; a commit that hits remote-ahead only
  // marks conflict in memory, so subscribe to catch exactly that transition.
  let lastConflict = !!ctx.sync?.hasConflict();
  if (ctx.sync) unsub = ctx.sync.onStatusChange(() => {
    const c = !!ctx.sync.hasConflict();
    if (c !== lastConflict) { lastConflict = c; refresh(); }
  });

  await refresh();
  return controller;
}
