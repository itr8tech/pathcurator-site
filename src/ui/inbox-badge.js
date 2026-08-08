// src/ui/inbox-badge.js — the "Inbox" nav-link count badge (unsorted items). Mounted once at boot;
// re-counts on inbox/bookmark change events and on primary handoff. Hidden at zero. Reuses the
// .sync-badge styling for a consistent header badge.
export function mountInboxBadge(db) {
  const link = document.getElementById('nav-inbox');
  const badge = document.getElementById('inbox-badge');
  if (!link || !badge) return () => {};
  const render = async () => {
    let n = 0;
    try { n = await db.countInboxUnsorted(); } catch { n = 0; }   // follower before primary is up → 0
    if (n > 0) {
      badge.hidden = false; badge.textContent = String(n); badge.className = 'sync-badge sync-badge--warn';
      link.setAttribute('aria-label', `Inbox — ${n} unsorted item${n === 1 ? '' : 's'}`);
    } else {
      badge.hidden = true; badge.textContent = ''; link.setAttribute('aria-label', 'Inbox');
    }
  };
  const unsub = db.onChange((evt) => {
    if (!evt) return;
    if (evt.entity === 'inbox' || evt.entity === 'bookmarks' || evt.entity === '*' ||
        evt.type === 'promoted' || evt.type === 'primary-up') render();
  });
  render();
  return unsub;
}
