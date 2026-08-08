// src/ui/views/inbox.js — #/inbox: the local capture inbox. Lists unsorted / filed / dismissed
// items; file one into a pathway (→ a bookmark), dismiss, delete, or restore. Captured content is
// UNTRUSTED: titles render as textContent, URLs only become live links for safe schemes (via the
// sanitizer's safeUrl), and notes go through the markdown sanitizer — same boundary as pathway text.
import { el, clear } from '../dom.js';
import { openInboxTriage, openManualAdd } from '../inbox-triage.js';
import { announce } from '../a11y.js';

const STATUSES = [['unsorted', 'Unsorted'], ['triaged', 'Filed'], ['dismissed', 'Dismissed']];
const SOURCE_LABEL = { bookmarklet: 'Bookmarklet', 'share-target': 'Shared', manual: 'Manual', extension: 'Extension', protocol: 'Link', file: 'File' };

const hostOf = (u) => { try { return new URL(u).host; } catch { return String(u || ''); } };
function when(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(ts).toISOString().slice(0, 10);
}

export default async function mount(container, params, ctx) {
  const root = el('div', { class: 'view-content' }); container.append(root);
  let status = params.query?.get('status') || 'unsorted';
  if (!STATUSES.some(([s]) => s === status)) status = 'unsorted';
  const controller = { title: 'Inbox', refresh, destroy() {} };

  const btn = (txt, props, fn) => { const b = el('button', { type: 'button', ...props }, txt); b.addEventListener('click', fn); return b; };
  const act = async (fn) => { try { await fn(); } catch (e) { announce(e.message || 'Action failed.', { assertive: true }); } };

  function itemCard(it, primary) {
    const li = el('li', { class: 'inbox-item', 'data-id': it.id, 'data-focus-key': `inbox:${it.id}` });
    li.append(el('div', { class: 'inbox-item__head' },
      el('strong', { class: 'inbox-item__title' }, it.title || hostOf(it.url)),
      el('span', { class: 'inbox-item__meta muted' }, `${SOURCE_LABEL[it.source] || it.source || 'Captured'} · ${when(it.created_at)}`)));

    // URL: host as text + a "Open" link ONLY for a safe scheme (never a live href for javascript:/etc.)
    const safe = ctx.md.safeUrl(it.url);
    const urlRow = el('div', { class: 'inbox-item__url muted' }, hostOf(it.url), ' ');
    urlRow.append(safe
      ? el('a', { href: safe, target: '_blank', rel: 'noopener noreferrer nofollow ugc' }, 'Open ↗')
      : el('span', { class: 'blocked' }, '(link blocked — unsupported scheme)'));
    li.append(urlRow);

    const body = it.note || it.description;
    if (body) { const d = el('div', { class: 'inbox-item__note prose' }); ctx.md.renderMarkdownInto(d, body); li.append(d); }

    if (primary) {
      const actions = el('div', { class: 'inbox-item__actions' });
      if (it.status === 'unsorted') {
        actions.append(
          btn('File…', { class: 'btn btn--sm btn--primary', 'data-requires-primary': true }, (ev) => openInboxTriage({ item: it, invoker: ev.currentTarget, ctx })),
          btn('Dismiss', { class: 'btn btn--sm', 'data-requires-primary': true }, () => act(() => ctx.db.updateInboxStatus({ id: it.id, status: 'dismissed' }))));
      } else {
        actions.append(btn('Restore', { class: 'btn btn--sm', 'data-requires-primary': true }, () => act(() => ctx.db.updateInboxStatus({ id: it.id, status: 'unsorted' }))));
      }
      actions.append(btn('Delete', { class: 'btn btn--sm btn--danger', 'data-requires-primary': true }, () => act(() => ctx.db.deleteInboxItem({ id: it.id }))));
      li.append(actions);
    }
    return li;
  }

  const emptyMsg = (s) => s === 'unsorted'
    ? 'Your inbox is empty. Capture links with the bookmarklet, the /add page, a share, or “Add manually”.'
    : s === 'triaged' ? 'Nothing filed into a pathway yet.' : 'Nothing dismissed.';

  let bmPanel = null;
  function toggleBookmarklet(invoker) {
    if (bmPanel) { bmPanel.remove(); bmPanel = null; return; }
    const code = el('textarea', { class: 'bookmarklet-code', readonly: true, rows: 3 });
    code.value = `javascript:(()=>{window.open('${location.origin}/add/?popup=1&url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title),'pc_add','width=460,height=340')})()`;
    bmPanel = el('div', { class: 'bookmarklet-help card' },
      el('p', {}, 'Make a new browser bookmark and paste this as its address (URL). Click it on any page to send that page to your inbox:'),
      code);
    invoker.after(bmPanel);
    code.focus(); code.select();
  }

  async function refresh() {
    const [items, unsorted] = await Promise.all([ctx.db.listInbox(status), ctx.db.countInboxUnsorted()]);
    const primary = ctx.isPrimary();
    clear(root);
    root.append(el('h1', { 'data-view-heading': true, tabindex: -1 }, 'Inbox'),
      el('p', { class: 'muted' }, 'Links you’ve captured. Sort them into a pathway, or dismiss.'));

    if (primary) root.append(el('div', { class: 'dashboard-actions' },
      btn('+ Add manually', { class: 'btn', 'data-requires-primary': true, 'data-focus-key': 'inbox-add' }, (ev) => openManualAdd({ invoker: ev.currentTarget, ctx })),
      btn('Bookmarklet…', { class: 'btn', 'data-focus-key': 'inbox-bm' }, (ev) => toggleBookmarklet(ev.currentTarget))));

    const tabs = el('div', { class: 'inbox-tabs', role: 'tablist', 'aria-label': 'Inbox filter' });
    for (const [s, label] of STATUSES) {
      tabs.append(el('a', { class: `inbox-tab ${s === status ? 'is-active' : ''}`, href: `#/inbox?status=${s}`,
        role: 'tab', 'aria-selected': String(s === status) }, label, s === 'unsorted' && unsorted ? ` (${unsorted})` : ''));
    }
    root.append(tabs);

    if (!items.length) { root.append(el('p', { class: 'muted inbox-empty' }, emptyMsg(status))); return; }
    const list = el('ul', { class: 'inbox-list', role: 'list' });
    for (const it of items) list.append(itemCard(it, primary));
    root.append(list);
  }

  await refresh();
  return controller;
}
