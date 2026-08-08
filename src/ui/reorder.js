// src/ui/reorder.js — explicit up/down reorder buttons (no drag-and-drop).
// A single DB-authoritative moveEntity commit; the change event re-renders with focus retention.
import { el } from './dom.js';
import { announce } from './a11y.js';

/** Up/down control pair for a reorderable item. Disabled at the boundaries. */
export function reorderControls({ entity, id, index, count, label }) {
  const up = el('button', { type: 'button', class: 'btn btn--icon move-btn', 'data-move': 'up',
    'data-requires-primary': true, 'aria-label': `Move ${label} up`, 'data-focus-key': `${entity}-up:${id}`,
    disabled: index === 0 }, '↑');
  const down = el('button', { type: 'button', class: 'btn btn--icon move-btn', 'data-move': 'down',
    'data-requires-primary': true, 'aria-label': `Move ${label} down`, 'data-focus-key': `${entity}-down:${id}`,
    disabled: index === count - 1 }, '↓');
  return el('span', { class: 'reorder-controls', role: 'group' }, up, down);
}

/** Delegate move-button clicks under `root`. Returns a teardown. */
export function initReorder(root, ctx) {
  async function onClick(e) {
    const btn = e.target.closest('button[data-move]');
    if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return;
    if (document.body.dataset.role === 'follower') return;
    const li = btn.closest('[data-id]');
    const list = li?.parentElement;
    if (!list || !list.dataset.reorderScope) return;
    const dir = btn.dataset.move === 'up' ? -1 : 1;
    const entity = list.dataset.reorderScope, id = li.dataset.id;
    const sibs = [...list.querySelectorAll(':scope > [data-id]')];
    const to = sibs.findIndex((x) => x.dataset.id === id) + dir;
    if (to < 0 || to >= sibs.length) return;                 // boundary — nothing to do
    try {
      await ctx.db.moveEntity({ entity, id, toParentId: list.dataset.parent ?? null, toIndex: to });
      announce(`Moved ${dir < 0 ? 'up' : 'down'} to position ${to + 1} of ${sibs.length}.`);
    } catch (err) {
      announce(err.message || 'Could not move item.', { assertive: true });
    }
  }
  root.addEventListener('click', onClick);
  return () => root.removeEventListener('click', onClick);
}
