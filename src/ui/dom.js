// src/ui/dom.js — dependency-free. Untrusted text ONLY via textContent or an appended sanitized fragment.
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k in node) node[k] = v;                        // properties: textContent, value, disabled, href…
    else node.setAttribute(k, v === true ? '' : String(v)); // attributes: aria-*, data-focus-key, role…
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c?.nodeType ? c : document.createTextNode(String(c))); // DocumentFragment appends safely
  }
  return node;
}
export const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); return n; };

// Instant tooltip button — shows on hover AND keyboard focus (no ~1s title-attribute delay), wired
// via aria-describedby so screen readers get the fuller text too. Returns the .tt-wrap span; query
// 'button' inside for the control. align 'end' anchors the tip to the right edge (for toolbars at
// the right side of the viewport).
let ttSeq = 0;
export function ttButton(label, tip, props = {}, fn = null, align = 'start') {
  const id = `tt-${++ttSeq}`;
  const b = el('button', { type: 'button', ...props, 'aria-describedby': id }, label);
  if (fn) b.addEventListener('click', fn);
  return el('span', { class: `tt-wrap${align === 'end' ? ' tt-wrap--end' : ''}` }, b,
    el('span', { class: 'tt', role: 'tooltip', id }, tip));
}
export const on = (n, ev, fn, opts) => { n.addEventListener(ev, fn, opts); return () => n.removeEventListener(ev, fn, opts); };
