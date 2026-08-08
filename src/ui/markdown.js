// src/ui/markdown.js — the SECURITY BOUNDARY. All untrusted pathway/step/bookmark text renders
// on the PAT-holding origin, so an XSS here reaches secrets. Self-authored, no library.
// Pipeline: markdown -> HTML string -> inert <template> parse -> allow-list rebuild -> DocumentFragment.

const DROP_SUBTREE = new Set(['script','style','iframe','object','embed','form','input','button','textarea','select',
  'link','meta','base','svg','math','template','noscript','title','frame','frameset','applet','marquee',
  'audio','video','source','track','img','picture']);
const ALLOWED = {
  a:['href','title'], p:['class'], br:[], hr:[], strong:[], em:[], b:[], i:[], u:[], s:[], del:[], ins:[], sub:[], sup:[],
  code:[], pre:[], kbd:[], samp:[], var:[], mark:[], abbr:['title'], small:[],
  h2:[],h3:[],h4:[],h5:[],h6:[], ul:[], ol:['start'], li:[], dl:[], dt:[], dd:[], blockquote:[], span:['class'],
  table:[], thead:[], tbody:[], tfoot:[], tr:[], th:['scope'], td:[], caption:[],
};
const ALLOWED_CLASSES = new Set(['font-weight-bold','fw-bold','font-italic','fst-italic','text-muted',
  'text-decoration-underline','text-decoration-line-through']);
const SAFE_SCHEMES = new Set(['http','https','mailto','tel']);

export function safeUrl(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return null;
  // Test the AUTHORITY on the string as the URL PARSER will see it, not as written. The parser
  // removes tab/LF/CR from anywhere in a URL, and for special schemes treats "\" exactly like "/".
  // Checking the raw string let three inputs smuggle an off-origin authority past the "//" test —
  // "/\host", "\\host" and "/<TAB>/host" each resolve to https://host.
  const authority = s.replace(/[\t\n\r]/g, '').replace(/\\/g, '/');
  if (/^\/\//.test(authority)) return null;                         // reject protocol-relative //host
  if (/^(#|\/|\.\.?\/|\?)/.test(authority)) return s;               // relative / anchor / query
  const bare = s.replace(/[\x00-\x20]+/g, '');                      // strip control/space: defeats jav[TAB]ascript:
  const m = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/.exec(bare);
  if (!m) return s;                                                 // no scheme -> relative
  return SAFE_SCHEMES.has(m[1].toLowerCase()) ? s : null;
}
const filterClasses = (v) => String(v ?? '').split(/\s+/).filter((c) => ALLOWED_CLASSES.has(c)).join(' ');

export function sanitizeHtml(dirtyHtml) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(dirtyHtml ?? '');                          // INERT parse (no exec, no fetch while detached)
  const frag = document.createDocumentFragment();
  cleanChildren(tpl.content, frag);
  return frag;
}
function cleanChildren(src, dest) {
  for (const child of Array.from(src.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) { dest.appendChild(document.createTextNode(child.nodeValue)); continue; }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;             // drop comments/PIs
    const tag = child.localName?.toLowerCase() || '';
    if (DROP_SUBTREE.has(tag)) continue;
    const allowed = ALLOWED[tag];
    if (!allowed) { cleanChildren(child, dest); continue; }          // unknown -> unwrap
    const out = document.createElement(tag);                        // fresh node: no parser-attached state
    for (const name of allowed) {
      if (!child.hasAttribute(name)) continue;
      let val = child.getAttribute(name);                           // decoded, post-parse
      if (name === 'href') { const u = safeUrl(val); if (u === null) { out.setAttribute('data-blocked-href', ''); continue; } val = u; }
      else if (name === 'class') { val = filterClasses(val); if (!val) continue; }
      out.setAttribute(name, val);
    }
    if (tag === 'a' && out.hasAttribute('href')) { out.setAttribute('rel', 'noopener noreferrer nofollow ugc'); out.setAttribute('target', '_blank'); }
    cleanChildren(child, out);
    dest.appendChild(out);
  }
}

// ---- markdown -> HTML (untrusted convenience; raw HTML passes through to the sanitizer) ----
const CODE_OPEN = '', CODE_CLOSE = '';   // private-use sentinels, absent from content                   // private-use sentinels, absent from content
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push('<code>' + escapeHtml(c) + '</code>'); return CODE_OPEN + (codes.length - 1) + CODE_CLOSE; });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, t, u) => '<a href="' + u + '">' + t + '</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*([^*\s][^*]*?)\*(?!\*)/g, '<em>$1</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(new RegExp(CODE_OPEN + '(\\d+)' + CODE_CLOSE, 'g'), (_, i) => codes[+i]);
  return s;
}
function mdToHtml(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = []; let i = 0; const para = [];
  const flush = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para.length = 0; } };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) { flush(); const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; } i++;
      out.push('<pre><code>' + escapeHtml(buf.join('\n')) + '</code></pre>'); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flush(); const lvl = Math.min(6, h[1].length + 1); out.push('<h' + lvl + '>' + inline(h[2].trim()) + '</h' + lvl + '>'); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
    if (/^\s*>\s?/.test(line)) { flush(); const buf = []; while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push('<blockquote>' + mdToHtml(buf.join('\n')) + '</blockquote>'); continue; }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) { flush(); const ordered = /^\s*\d+\./.test(line); const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, '')); i++; }
      out.push('<' + (ordered ? 'ol' : 'ul') + '>' + items.map((it) => '<li>' + inline(it) + '</li>').join('') + '</' + (ordered ? 'ol' : 'ul') + '>'); continue; }
    if (/^\s*$/.test(line)) { flush(); i++; continue; }
    if (/^\s*<\/?[a-zA-Z][\w-]*(\s|>|\/)/.test(line)) { flush(); out.push(line); i++; continue; } // raw HTML block -> passthrough
    para.push(line); i++;
  }
  flush();
  return out.join('\n');
}

export function renderMarkdown(src) { return sanitizeHtml(mdToHtml(src)); }
export function renderMarkdownInto(elm, src) {
  elm.setAttribute('aria-busy', 'true');
  elm.replaceChildren(renderMarkdown(src));                          // atomic swap
  elm.removeAttribute('aria-busy');
}
