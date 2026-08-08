// PathCurator v2 — pure stable-id 3-way merge classifier (P3, isomorphic).
// Matches pathways by stable id (never name/position). Inputs are content hashes from
// canonical.js: L = local, R = remote, B = base (last synced). Absent = null/undefined.
// `review: true` means a human must decide (per the locked "always review conflicts" rule) —
// nothing with review:true is auto-applied by a user-initiated pull.

// autoAction ∈ add | replace | delete-local | keep-local | noop | review
export function classifyPathway({ id, local = null, remote = null, base = null }) {
  const inLocal = local != null, inRemote = remote != null, inBase = base != null;

  if (inRemote && !inLocal) {
    if (!inBase) return { id, status: 'added', autoAction: 'add' };
    if (remote !== base) return { id, status: 'local-deleted-remote-edited', autoAction: 'add', review: true };
    return { id, status: 'local-deleted-clean', autoAction: 'noop' };            // honor the local delete
  }
  if (inLocal && !inRemote) {
    if (!inBase) return { id, status: 'local-only-new', autoAction: 'noop' };     // keep; committed later
    if (local === base) return { id, status: 'remote-deleted', autoAction: 'delete-local' };
    return { id, status: 'remote-deleted-local-edited', autoAction: 'keep-local', review: true };
  }
  // present on both sides
  if (local === remote) return { id, status: 'unchanged', autoAction: 'noop' };
  if (local === base) return { id, status: 'ff-remote', autoAction: 'replace' };  // only remote moved
  if (remote === base) return { id, status: 'ff-local', autoAction: 'noop' };     // only local moved
  return { id, status: 'conflict', autoAction: 'review', review: true };          // both moved
}

// entries: [{ id, local, remote, base }] over the UNION of local ∪ remote ∪ base ids.
export function buildPlan(entries) {
  const items = entries.map(classifyPathway);
  const review = items.filter((i) => i.review);
  const auto = items.filter((i) => !i.review);
  const counts = {};
  for (const i of items) counts[i.status] = (counts[i.status] || 0) + 1;
  return { items, auto, review, needsReview: review.length > 0, counts };
}

// The choices a reviewer may pick per review-status, and the default (safest) resolution.
export const REVIEW_CHOICES = {
  conflict: { choices: ['keep-local', 'replace'], default: 'keep-local' },
  'remote-deleted-local-edited': { choices: ['keep-local', 'delete'], default: 'keep-local' },
  'local-deleted-remote-edited': { choices: ['add', 'skip'], default: 'add' },
};

// Map a review item + the reviewer's choice → an apply decision action.
export function resolutionToAction(item, choice) {
  const cfg = REVIEW_CHOICES[item.status];
  const pick = cfg && cfg.choices.includes(choice) ? choice : (cfg?.default ?? 'keep-local');
  if (pick === 'replace' || pick === 'add') return item.status === 'conflict' || item.status === 'local-deleted-remote-edited' ? 'replace' : 'add';
  if (pick === 'delete') return 'delete';
  return 'noop';   // keep-local / skip
}

// The non-interactive / unattended default: never lose un-pushed local work.
export const nonInteractiveAction = (item) => (item.status === 'remote-deleted' ? 'delete-local' : 'noop');
