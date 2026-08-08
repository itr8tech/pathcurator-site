// src/ui/pathway-diff.js — pure field-level diff between two pathway objects, matched by stable id.
// Returns human-readable strings (rendered as textContent → safe for untrusted content). The fields
// checked mirror exactly what the content hash covers, so a genuine difference never yields an empty
// list. Used by the pull merge-review (#/merge) and the uncommitted-changes review/discard flow.
const byOrder = (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0);
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export function summarizeDiff(local, remote, localImgSha, remoteImgSha) {
  const out = [];
  const changed = (a, b) => (a ?? '') !== (b ?? '');
  if (changed(local.name, remote.name)) out.push(`Name: “${local.name}” → “${remote.name}”`);
  if (changed(local.description, remote.description)) out.push('Description edited');
  if (changed(local.content_warning, remote.content_warning)) out.push('Content warning edited');
  if (changed(local.acknowledgments, remote.acknowledgments)) out.push('Acknowledgments edited');

  if (localImgSha !== remoteImgSha) {
    out.push(localImgSha && remoteImgSha ? 'Header image changed'
      : remoteImgSha ? 'Header image added' : 'Header image removed');
  }

  const lSteps = [...(local.steps || [])].sort(byOrder);
  const rSteps = [...(remote.steps || [])].sort(byOrder);
  const lStepIds = lSteps.map((s) => s.id), rStepIds = rSteps.map((s) => s.id);
  const rStepById = new Map(rSteps.map((s) => [s.id, s]));
  const stepsAdded = rStepIds.filter((id) => !lStepIds.includes(id)).length;
  const stepsRemoved = lStepIds.filter((id) => !rStepIds.includes(id)).length;
  if (stepsAdded) out.push(`${plural(stepsAdded, 'step')} added`);
  if (stepsRemoved) out.push(`${plural(stepsRemoved, 'step')} removed`);
  if (!stepsAdded && !stepsRemoved && lStepIds.join(',') !== rStepIds.join(',')) out.push('Steps reordered');
  let stepsEdited = 0;
  for (const s of lSteps) {
    const rs = rStepById.get(s.id);
    if (rs && (changed(s.name, rs.name) || changed(s.objective, rs.objective) || changed(s.pause_and_reflect, rs.pause_and_reflect))) stepsEdited++;
  }
  if (stepsEdited) out.push(`${plural(stepsEdited, 'step')} edited`);

  const flat = (steps) => steps.flatMap((s) => (s.bookmarks || []).map((b) => ({ ...b, _step: s.id })));
  const lb = flat(lSteps), rb = flat(rSteps);
  const rbById = new Map(rb.map((b) => [b.id, b]));
  const lbIds = new Set(lb.map((b) => b.id));
  const bmAdded = rb.filter((b) => !lbIds.has(b.id)).length;
  const bmRemoved = lb.filter((b) => !rbById.has(b.id)).length;
  if (bmAdded) out.push(`${plural(bmAdded, 'link')} added`);
  if (bmRemoved) out.push(`${plural(bmRemoved, 'link')} removed`);
  let bmEdited = 0, bmMoved = 0;
  for (const b of lb) {
    const r = rbById.get(b.id);
    if (!r) continue;
    if (b._step !== r._step) bmMoved++;
    else if (changed(b.title, r.title) || changed(b.url, r.url) || changed(b.description, r.description)
      || changed(b.context, r.context) || (b.required ? 1 : 0) !== (r.required ? 1 : 0) || changed(b.content_type, r.content_type)) bmEdited++;
  }
  if (bmEdited) out.push(`${plural(bmEdited, 'link')} edited`);
  if (bmMoved) out.push(`${plural(bmMoved, 'link')} moved between steps`);

  if (!out.length) out.push('These versions differ');   // safety net: a real difference always has a cause
  return out;
}
