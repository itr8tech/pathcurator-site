// src/ui/publish-html.js — P7: generate a fully self-contained, interactive, learner-facing HTML
// page for one pathway. XSS-safe BY CONSTRUCTION: the page is built as a detached DOM with the
// app's el()/textContent discipline, markdown renders through the app's sanitizer, every href
// passes safeUrl, and the inline <script>/<style> are STATIC CONSTANTS — no per-pathway data is
// ever placed in a raw-text element (the header image data: URL lives in an <img src> attribute,
// from an allowlisted MIME, re-encoded to a size budget). Serialized with an explicit doctype so
// the artifact renders in standards mode. Zero external requests — works offline, from file://,
// email attachments, and sandboxed LMS iframes (storage failures degrade to an in-memory session
// with a visible notice; Save/Restore progress files are the durable path).
//
// Progress volatility story (better than legacy): storage key by PATHWAY ID (survives renames),
// entries by BOOKMARK ID (survive URL fixes and re-exported updates), plus Save/Restore.
import { el } from './dom.js';
import { renderMarkdown, safeUrl } from './markdown.js';
import { slugify } from '/src/data/exchange.js';

const OK_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const today = () => new Date().toISOString().slice(0, 10);

// Re-encode the header image to a bounded JPEG data: URL (≤ ~300 KB binary). Any failure → no image.
async function encodeHeaderImage(hi, images) {
  try {
    if (!hi?.sha256) return null;
    const img = images?.[hi.sha256];
    if (!img?.bytes || !OK_MIME.has(img.mime)) return null;
    const bytes = img.bytes instanceof Uint8Array ? img.bytes : new Uint8Array(img.bytes);
    const bmp = await createImageBitmap(new Blob([bytes], { type: img.mime }));
    const scale = Math.min(1, 1600 / bmp.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    let out = canvas.toDataURL('image/jpeg', 0.82);
    if (out.length > 400000) out = canvas.toDataURL('image/jpeg', 0.6);
    return out.length > 420000 ? null : out;
  } catch { return null; }
}

// attribution: OFF by default — author names are only published when the curator opts in
// (setting 'publish_attribution'; richer attribution — bio, author link — is a recorded TODO).
export async function buildPathwayHtml(db, { id, attribution = false }) {
  const d = await db.exportPathwayData(id);
  const p = d.obj.pathway;
  const slug = slugify(p.name);
  const headerImgUrl = await encodeHeaderImage(p.header_image, d.images);

  const doc = document.implementation.createHTMLDocument(p.name || 'Pathway');
  doc.documentElement.setAttribute('lang', 'en');
  doc.head.append(
    el('meta', { charset: 'utf-8' }),
    el('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
    el('meta', { name: 'color-scheme', content: 'light dark' }),
    el('meta', { name: 'generator', content: 'PathCurator' }));
  const style = doc.createElement('style');
  style.textContent = PAGE_CSS;                                // STATIC — never per-pathway data
  doc.head.append(style);

  const body = doc.body;
  body.setAttribute('data-pathway-id', String(p.id));
  body.setAttribute('data-slug', slug);

  const mdBlock = (cls, src) => el('div', { class: cls }, renderMarkdown(src));

  // ---- header (banner image first, content warning directly under it) ----
  body.append(el('a', { class: 'skip-link', href: '#steps' }, 'Skip to the steps'));
  const header = el('header', { class: 'page-header' },
    el('h1', {}, p.name || 'Pathway'),
    el('p', { class: 'byline' },
      [attribution && p.created_by ? `Curated by ${p.created_by}` : null,
        p.version ? `version ${p.version}` : null,
        `exported ${today()}`].filter(Boolean).join(' · ')));
  if (headerImgUrl) header.append(el('img', { class: 'header-img', src: headerImgUrl, alt: '' }));
  if (p.content_warning) header.append(el('div', { class: 'content-warning', role: 'note' },
    el('strong', {}, 'Content warning'), mdBlock('cw-body', p.content_warning)));
  if (p.description) header.append(mdBlock('description', p.description));
  body.append(header);

  // ---- control bar ----
  // A named <section>, not a bare <div>: this bar sits BETWEEN the <header> and <main> landmarks,
  // so as a div its progress bar and search box belonged to no landmark at all — unreachable by
  // screen-reader landmark navigation. A section with an accessible name is itself a landmark.
  body.append(el('section', { class: 'control-bar', id: 'controls', 'aria-label': 'Pathway controls' },
    el('div', { class: 'progress-wrap', id: 'progress-wrap', hidden: true },
      el('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Required links launched', 'aria-valuemin': '0', 'aria-valuemax': '100' },
        el('div', { class: 'progress-bar', id: 'pbar' })),
      el('span', { class: 'progress-text', id: 'pcount' }, ''),
      el('span', { class: 'progress-pct', id: 'ppct' }, '')),
    el('div', { class: 'control-row' },
      el('input', { type: 'search', id: 'search', placeholder: 'Search this pathway…', 'aria-label': 'Search this pathway' }),
      el('button', { type: 'button', id: 'expand-all' }, 'Expand all'),
      el('button', { type: 'button', id: 'collapse-all' }, 'Collapse all'),
      // Popover API (not details/summary): light-dismiss on outside click + Esc + top layer, free.
      el('button', { type: 'button', class: 'gear-btn', popovertarget: 'gear-menu', 'aria-label': 'Settings: theme and progress' }, '⚙'),
      el('div', { class: 'gear-menu', id: 'gear-menu', popover: 'auto' },
        el('button', { type: 'button', id: 'theme-btn' }, '🌗 Switch theme'),
        el('button', { type: 'button', id: 'save-progress' }, '💾 Save progress'),
        el('button', { type: 'button', id: 'restore-progress' }, '↥ Restore progress'),
        el('button', { type: 'button', id: 'dl-bookmarks', title: 'Download this pathway as a bookmarks file you can import into any browser — a folder per step' }, '🔖 Browser bookmarks')),
      el('input', { type: 'file', id: 'restore-file', accept: 'application/json,.json', hidden: true })),
    el('p', { class: 'notice', id: 'storage-note', hidden: true },
      'Progress can’t be saved in this context — it will last for this session only. Use “Save progress” to keep a copy.'),
    el('p', { class: 'notice', id: 'search-count', hidden: true, role: 'status' }, '')));

  // ---- steps ----
  // Steps AND links are collapsed by default: the page opens as a scannable outline (titles +
  // badges), each link expanding to its description, context, and launch button. Each link is its
  // own card so entries don't bleed together.
  const stepsWrap = el('main', { id: 'steps' });
  (p.steps || []).forEach((s, i) => {
    // Required links grouped first; bonus in their own subtly-distinct section (dashed cards).
    const grouped = [...(s.bookmarks || []).filter((b) => b.required), ...(s.bookmarks || []).filter((b) => !b.required)];
    const hasBoth = grouped.length && grouped.some((b) => b.required) && grouped.some((b) => !b.required);
    const articles = grouped.flatMap((b, bi) => {
      const safe = safeUrl(b.url);
      const label = hasBoth && (bi === 0 || !!grouped[bi - 1].required !== !!b.required)
        ? [el('h3', { class: 'bm-group-label' }, b.required ? 'Required' : 'Bonus')] : [];
      return [...label, el('article', { class: `bm${b.required ? '' : ' bm--bonus'}`, 'data-bm-id': String(b.id), 'data-required': b.required ? '1' : '0',
        'data-added': b.added_at ? String(b.added_at) : null },
        el('details', {},
          el('summary', {},
            el('h3', {}, b.title || b.url),
            el('span', { class: 'bm-badges' },
              el('span', { class: 'badge type' }, b.content_type || 'Read'),
              el('span', { class: `badge ${b.required ? 'req' : 'bonus'}` }, b.required ? 'Required' : 'Bonus'),
              el('span', { class: 'badge launched-badge' }, '✓ Launched'))),
          el('div', { class: 'bm-body' },
            b.description ? mdBlock('bm-desc', b.description) : null,
            b.context ? el('aside', { class: 'bm-context' },
              el('span', { class: 'bm-context__label' }, 'Context'), renderMarkdown(b.context)) : null,
            el('p', { class: 'bm-actions' },
              safe ? el('a', { class: 'launch-btn', href: safe, target: '_blank', rel: 'noopener noreferrer', 'data-bm-id': String(b.id) }, 'Launch ↗')
                : el('span', { class: 'bm-nolink' }, `${b.url} (link unavailable)`),
              el('button', { type: 'button', class: 'mark-done', 'data-bm-id': String(b.id) }, 'mark as done')))))];
    });
    stepsWrap.append(el('section', { class: 'step' },
      el('details', {},
        el('summary', {},
          el('h2', {}, s.name || `Step ${i + 1}`), ' ',
          el('span', { class: 'step-summary muted' }, '')),
        s.objective ? mdBlock('step-objective', s.objective) : null,
        ...articles,
        s.pause_and_reflect ? el('div', { class: 'pause-reflect-section' },
          el('h3', {}, 'Pause & reflect'), renderMarkdown(s.pause_and_reflect)) : null)));
  });
  body.append(stepsWrap);

  // ---- footer ----
  const footer = el('footer', { class: 'page-footer' });
  if (p.acknowledgments) footer.append(el('h2', {}, 'Acknowledgments'), mdBlock('acknowledgments', p.acknowledgments));
  footer.append(el('p', { class: 'muted' },
    `Generated by PathCurator · ${p.version ? `version ${p.version} · ` : ''}${today()}. `,
    // Own span: in LMS mode this caveat is false (the LMS saves) — CSS hides it there.
    el('span', { class: 'storage-caveat' },
      'Your launch progress is saved in this browser — use “Save progress” for a copy you can move between devices.')));
  body.append(footer,
    el('button', { type: 'button', id: 'to-top', 'aria-label': 'Scroll to top', hidden: true }, '↑ Top'));

  const script = doc.createElement('script');
  script.textContent = TRACKER_JS;                             // STATIC — never per-pathway data
  body.append(script);

  return {
    content: '<!doctype html>\n' + doc.documentElement.outerHTML,
    filename: `${slug}--web--${today()}.html`,
    meta: { id: p.id, name: p.name, version: p.version, slug },   // for package builders (SCORM/CC)
  };
}

// ====================================================================================
// STATIC CONSTANTS ONLY BELOW. No export-time data is ever interpolated into these, and
// they must not contain the raw-text-breaking sequences "<\/script", "<\/style", or "<!--"
// (tests enforce it).
// ====================================================================================

const PAGE_CSS = String.raw`
:root{--bg:#f6f8fa;--surface:#fff;--text:#1f2328;--muted:#59636e;--border:#d1d9e0;--accent:#0969da;
  --ok:#1a7f37;--warn:#9a6700;--danger:#c0392b;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0d1117;--surface:#151b23;--text:#e6edf3;--muted:#9198a1;--border:#3d444d}}
:root[data-theme=dark]{--bg:#0d1117;--surface:#151b23;--text:#e6edf3;--muted:#9198a1;--border:#3d444d}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0 auto;max-width:52rem;padding:1rem 1.25rem 4rem;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  font-size:1.0625rem;line-height:1.6;background:var(--bg);color:var(--text)}
h1{font-size:1.75rem;margin:.5rem 0 .25rem}h2{font-size:1.2rem;margin:0}h3{font-size:1.05rem;margin:0 0 .25rem}
a{color:var(--accent)}
.skip-link{position:absolute;left:-9999px}.skip-link:focus{position:static;display:inline-block;padding:.25rem .5rem}
.byline{color:var(--muted);margin:.1rem 0 .75rem;font-size:.9rem}
.header-img{max-width:100%;border-radius:10px;margin:.5rem 0}
.content-warning{border:1px solid var(--warn);border-left:4px solid var(--warn);border-radius:8px;padding:.6rem .9rem;margin:.75rem 0;background:color-mix(in srgb,var(--warn) 8%,var(--surface))}
.control-bar{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--border);padding:.6rem 0;margin:.5rem 0 1rem}
.control-row{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center}
.control-row input[type=search]{flex:1;min-width:10rem;padding:.35rem .6rem;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text)}
button{font:inherit;font-size:.875rem;padding:.3rem .7rem;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);cursor:pointer}
button:hover{border-color:var(--accent)}
.progress-wrap{display:flex;align-items:center;gap:.6rem;margin-bottom:.5rem}
.progress{flex:1;height:.9rem;background:var(--surface);border:1px solid var(--border);border-radius:999px;overflow:hidden}
.progress-bar{height:100%;width:0;background:var(--accent);transition:width .3s}
.progress-bar.p66{background:#2da44e}.progress-bar.p100{background:var(--ok)}
.progress-text{font-size:.85rem;color:var(--muted);white-space:nowrap}
.progress-pct{font-size:.85rem;font-weight:700;white-space:nowrap}
.notice{font-size:.85rem;color:var(--muted);margin:.4rem 0 0}
.step{margin:1rem 0}
.step>details{border:1px solid var(--border);border-radius:10px;background:var(--surface);padding:.25rem .9rem}
.step summary{cursor:pointer;padding:.5rem 0;display:flex;align-items:baseline;gap:.6rem;flex-wrap:wrap}
/* display:flex on summary silently removes the native disclosure marker — restore a visible
   affordance with a pseudo caret. content:"▸" / "" (empty alt text) keeps the glyph OUT of the
   accessible name; the a11y-tree semantics (expanded/collapsed) never depended on the marker. */
.step summary::before,.bm summary::before{content:"▸" / "";flex:none;color:var(--muted);
  transition:transform .15s;transform-origin:center}
details[open]>summary::before{transform:rotate(90deg)}
@media (prefers-reduced-motion:reduce){.step summary::before,.bm summary::before{transition:none}}
.step summary h2{display:inline}
.step-summary{font-size:.85rem}
.step-objective{border-bottom:1px solid var(--border);padding-bottom:.5rem;margin-bottom:.5rem}
.bm{border:1px solid var(--border);border-radius:10px;background:var(--bg);margin:.6rem 0;overflow:hidden}
.bm--bonus{border-style:dashed}
.bm-group-label{font-size:.72rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:.9rem 0 .25rem}
.bm>details{padding:.15rem .8rem}
.bm summary{cursor:pointer;display:flex;align-items:baseline;gap:.6rem;flex-wrap:wrap;padding:.45rem 0}
.bm summary h3{display:inline;margin:0}
.bm-body{padding:.25rem 0 .6rem;border-top:1px solid var(--border)}
.bm-badges{display:inline-flex;gap:.4rem}
.badge{font-size:.78rem;border:1px solid var(--border);border-radius:999px;padding:.05rem .55rem;background:var(--surface)}
.badge.req{color:var(--danger);border-color:var(--danger)}
.badge.bonus{color:var(--muted)}
.badge.launched-badge{display:none;color:var(--ok);border-color:var(--ok);font-weight:700}
.bm.is-launched .launched-badge{display:inline-block}
.bm.is-launched summary h3{color:var(--ok)}
.bm.is-launched{border-color:color-mix(in srgb,var(--ok) 45%,var(--border))}
.bm-context{border-left:4px solid var(--accent);background:color-mix(in srgb,var(--accent) 9%,var(--surface));
  border-radius:8px;padding:.5rem .8rem;margin:.6rem 0;font-size:.95rem}
.bm-context__label{display:block;font-size:.72rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--accent);margin-bottom:.15rem}
.bm-actions{display:flex;gap:.6rem;align-items:center;margin:.5rem 0 0}
.gear-btn{font-size:1.1rem;padding:.25rem .55rem}
.gear-btn[aria-expanded="true"]{border-color:var(--accent)}
/* display ONLY under :popover-open — an unconditional display would defeat the UA's
   closed-popover display:none (same trap as [hidden]). Position is set by script on toggle. */
.gear-menu[popover]{position:fixed;inset:auto;margin:0;gap:.35rem;padding:.5rem;
  background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.18);min-width:11.5rem}
.gear-menu:popover-open{display:grid}
.gear-menu button{text-align:left}
/* SCORM/LMS mode: the LMS owns persistence — hide Save/Restore and the browser-storage caveat.
   Theme + browser-bookmarks stay. */
.lms-mode #save-progress,.lms-mode #restore-progress,.lms-mode .storage-caveat{display:none}
.launch-btn{display:inline-block;background:var(--accent);color:#fff;border-radius:8px;padding:.35rem .9rem;text-decoration:none;font-weight:600}
.mark-done{font-size:.8rem;color:var(--muted)}
.bm-nolink{color:var(--muted);font-size:.9rem;word-break:break-all}
.pause-reflect-section{border-left:4px solid var(--accent);padding:.4rem .9rem;margin:.75rem 0;background:color-mix(in srgb,var(--accent) 6%,var(--surface));border-radius:8px}
.page-footer{margin-top:2rem;border-top:1px solid var(--border);padding-top:1rem}
.muted{color:var(--muted)}
.bm.search-hit{outline:2px solid var(--accent);outline-offset:4px;border-radius:8px}
#to-top{position:fixed;right:1rem;bottom:1rem}
.fw-bold,.font-weight-bold{font-weight:700}.fst-italic,.font-italic{font-style:italic}
.text-muted{color:var(--muted)}.text-decoration-underline{text-decoration:underline}
.text-decoration-line-through{text-decoration:line-through}
img{max-width:100%}
@media print{.control-bar,#to-top,.mark-done{display:none}}
`;

const TRACKER_JS = String.raw`(function () {
  'use strict';
  var body = document.body;
  var PID = body.getAttribute('data-pathway-id') || 'unknown';
  var SLUG = body.getAttribute('data-slug') || 'pathway';
  var KEY = 'pathcurator_progress_' + PID;
  var THEME_KEY = 'pathcurator_theme';

  // ==== SCORM 1.2 shim (P10) ====
  // Runs BEFORE the launched map builds. An LMS API found → SCORM mode: cmi.suspend_data replaces
  // localStorage for progress (the LMS attempt is its own context), status/score report to the
  // gradebook. No API (the normal web/file:// case) → everything below behaves exactly as before.
  // suspend keys: 32-bit FNV-1a of the FULL bookmark id, base36 — deterministic across package
  // versions by construction, charset-independent, computed at runtime from data-bm-id (the
  // static-constant rule holds: no per-pathway data in this script).
  function fnv(s) {
    var h = 0x811c9dc5;
    for (var fi = 0; fi < s.length; fi++) {
      h ^= s.charCodeAt(fi);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }
  // API discovery: walk the parent chain, then opener (+ its parents), bounded depth, EVERY hop
  // in try/catch — a cross-origin ancestor frame THROWS on property access; that must mean "keep
  // looking / standalone", never a crash.
  function findAPI(start) {
    var win = start;
    for (var d = 0; d < 10 && win; d++) {
      try { if (win.API) return win.API; } catch (e) { /* cross-origin frame — keep walking */ }
      var up = null;
      try { up = win.parent; } catch (e2) { break; }
      if (!up || up === win) break;
      win = up;
    }
    return null;
  }
  function initScorm() {
    var api = findAPI(window);
    if (!api) { try { if (window.opener) api = findAPI(window.opener); } catch (e) { /* cross-origin opener */ } }
    if (!api) return null;
    try { if (String(api.LMSInitialize('')) !== 'true') return null; } catch (e2) { return null; }
    var get = function (k) { try { var v = api.LMSGetValue(k); return v == null ? '' : String(v); } catch (e3) { return ''; } };
    var mode = get('cmi.core.lesson_mode') || 'normal';
    var n = parseInt(get('cmi.interactions._count'), 10);
    return { api: api, readOnly: mode === 'review' || mode === 'browse',
      entry: get('cmi.core.entry'), best: get('cmi.core.lesson_status'), suspend: get('cmi.suspend_data'),
      nextInteraction: isFinite(n) && n >= 0 ? n : 0, interactionsOff: false };
  }
  var scorm = initScorm();
  var scormFinished = false;
  var commitTimer = null;
  function scormSet(k, v) { try { return String(scorm.api.LMSSetValue(k, v)) === 'true'; } catch (e) { return false; } }
  function scormCommit() { commitTimer = null; try { scorm.api.LMSCommit(''); } catch (e) { /* the LMS's problem */ } }
  function scheduleCommit() { if (commitTimer) clearTimeout(commitTimer); commitTimer = setTimeout(scormCommit, 2000); }
  if (scorm) body.classList.add('lms-mode');

  // Storage wrapper: sandboxed LMS iframes, private windows, and file:// quirks must never break
  // the page — fall back to an in-memory session store and show the notice. In SCORM mode the
  // probe is skipped and the notice stays hidden — the LMS is saving, localStorage is never
  // touched for progress (theme still rides the guarded wrapper: cosmetic, silently in-memory
  // when blocked).
  var mem = {};
  var storageOk = true;
  function sGet(k) { try { return window.localStorage.getItem(k); } catch (e) { storageOk = false; return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; } }
  function sSet(k, v) { try { window.localStorage.setItem(k, v); storageOk = storageOk && true; } catch (e) { storageOk = false; mem[k] = v; } }
  if (!scorm) {
    try { window.localStorage.getItem(KEY); } catch (e) { storageOk = false; }
    if (!storageOk) { var note = document.getElementById('storage-note'); if (note) note.hidden = false; }
  }

  // Valid bookmark ids come from the DOM — restore files can never inject foreign keys.
  var validIds = Object.create(null);
  var articles = document.querySelectorAll('article[data-bm-id]');
  for (var ai = 0; ai < articles.length; ai++) validIds[articles[ai].getAttribute('data-bm-id')] = true;

  // id ↔ suspend-key maps (SCORM only). An intra-pathway hash collision (~1e-5) gets a
  // deterministic second hash round — every export derives the same rule from the DOM, so keys
  // stay stable across package versions and nothing extra is embedded.
  var keyById = Object.create(null);
  var idByKey = Object.create(null);
  if (scorm) {
    var byHash = Object.create(null);
    for (var ki in validIds) { var h1 = fnv(ki); (byHash[h1] = byHash[h1] || []).push(ki); }
    for (var hk in byHash) {
      var grp = byHash[hk];
      for (var gi = 0; gi < grp.length; gi++) {
        var kk = grp.length === 1 ? hk : hk + '.' + fnv('pc2:' + grp[gi]);
        keyById[grp[gi]] = kk; idByKey[kk] = grp[gi];
      }
    }
  }

  function loadLaunched() {
    var out = Object.create(null);
    if (scorm) {
      // suspend_data replaces localStorage: "v1:" + comma-joined hash keys (conservative
      // alphabet — base36 + . , : — some LMSs mangle exotic characters; 4,096-char cap holds to
      // ~450 links). A stored key that no longer matches a DOM id is dropped SILENTLY — that is
      // how removed/renamed links age out across package updates.
      var sraw = scorm.suspend || '';
      if (sraw.indexOf('v1:') === 0) {
        var toks = sraw.slice(3).split(',');
        for (var tn = 0; tn < toks.length; tn++) if (idByKey[toks[tn]]) out[idByKey[toks[tn]]] = 1;
      }
      return out;
    }
    try {
      var raw = sGet(KEY);
      if (!raw) return out;
      var parsed = JSON.parse(raw);
      var src = parsed && parsed.launched ? parsed.launched : {};
      for (var k in src) {
        if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
        if (!validIds[k]) continue;
        var t = Number(src[k]);
        if (isFinite(t) && t > 0) out[k] = t;
      }
    } catch (e) { /* corrupted store → start clean */ }
    return out;
  }
  var launched = loadLaunched();
  function persist() {
    if (scorm) {
      if (scorm.readOnly || scormFinished) return;
      var keys = [];
      for (var pk in launched) if (keyById[pk]) keys.push(keyById[pk]);
      scormSet('cmi.suspend_data', 'v1:' + keys.join(','));
      // Without exit=suspend, spec-strict LMSs (and Moodle's force-new-attempt) reset the
      // attempt and discard suspend_data. Written on EVERY commit path.
      scormSet('cmi.core.exit', 'suspend');
      scheduleCommit();
      return;
    }
    sSet(KEY, JSON.stringify({ schemaVersion: 1, pathwayId: PID, launched: launched }));
  }

  // Status ratchet + score. Only "completed"/"incomplete" (passed/failed imply scoring semantics
  // this page doesn't claim); NEVER write a lower status than achieved — a learner un-marking a
  // link must not downgrade a completed attempt. Zero required links → completed at init
  // (attendance semantics). score.raw = required percentage.
  var STATUS_RANK = { passed: 2, completed: 2, failed: 1, incomplete: 1 };
  function scormProgress(doneReq, totalReq) {
    if (!scorm || scorm.readOnly || scormFinished) return;
    var pct = totalReq === 0 ? 100 : Math.round((doneReq / totalReq) * 100);
    scormSet('cmi.core.score.raw', String(pct));
    var next = (totalReq === 0 || doneReq >= totalReq) ? 'completed' : 'incomplete';
    if (next !== scorm.best && (STATUS_RANK[next] || 0) >= (STATUS_RANK[scorm.best] || 0)) {
      if (scormSet('cmi.core.lesson_status', next)) scorm.best = next;
    }
    scormSet('cmi.core.exit', 'suspend');
    scheduleCommit();
  }

  function paint() {
    var totalReq = 0, doneReq = 0;
    for (var i = 0; i < articles.length; i++) {
      var art = articles[i];
      var id = art.getAttribute('data-bm-id');
      var isLaunched = !!launched[id];
      art.classList.toggle('is-launched', isLaunched);
      var done = art.querySelector('.mark-done');
      if (done) done.textContent = isLaunched ? 'mark as not done' : 'mark as done';
      if (art.getAttribute('data-required') === '1') { totalReq++; if (isLaunched) doneReq++; }
    }
    var wrap = document.getElementById('progress-wrap');
    if (wrap) {
      wrap.hidden = totalReq === 0;
      if (totalReq > 0) {
        var pct = Math.round((doneReq / totalReq) * 100);
        var bar = document.getElementById('pbar');
        bar.style.width = pct + '%';
        bar.className = 'progress-bar' + (pct === 100 ? ' p100' : pct >= 66 ? ' p66' : '');
        bar.parentNode.setAttribute('aria-valuenow', String(pct));
        document.getElementById('pcount').textContent = doneReq + ' of ' + totalReq + ' required launched';
        document.getElementById('ppct').textContent = pct + '%';
      }
    }
    scormProgress(doneReq, totalReq);   // no-op outside SCORM mode / in review mode
    var steps = document.querySelectorAll('.step');
    for (var s = 0; s < steps.length; s++) {
      var arts = steps[s].querySelectorAll('article[data-bm-id]');
      var req = 0, ln = 0;
      for (var a = 0; a < arts.length; a++) {
        if (arts[a].getAttribute('data-required') === '1') req++;
        if (launched[arts[a].getAttribute('data-bm-id')]) ln++;
      }
      var sum = steps[s].querySelector('.step-summary');
      if (sum) sum.textContent = arts.length + ' links · ' + req + ' required · ' + ln + ' launched';
    }
  }

  function mark(id, scrollTo) {
    if (!validIds[id]) return;
    launched[id] = Date.now();
    // Best-effort interactions record so the LMS's SCORM report shows WHICH links were opened.
    // Appends at the LMS's _count (resume-safe); id = the hash key (CMIIdentifier-safe whatever
    // the imported id's charset). First write failure disables further writes for the session;
    // duplicate records across sessions are accepted.
    if (scorm && !scorm.readOnly && !scormFinished && !scorm.interactionsOff) {
      var inum = scorm.nextInteraction;
      if (scormSet('cmi.interactions.' + inum + '.id', keyById[id] || fnv(id))) {
        scorm.nextInteraction = inum + 1;
        scormSet('cmi.interactions.' + inum + '.type', 'other');
      } else scorm.interactionsOff = true;
    }
    persist();
    paint();
    if (scrollTo && scrollTo.scrollIntoView) setTimeout(function () { scrollTo.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 120);
  }
  function onLaunch(ev) {
    var t = ev.target;
    var a2 = t && t.closest ? t.closest('a.launch-btn[data-bm-id]') : null;
    if (!a2) return;
    if (ev.type === 'auxclick' && ev.button !== 1) return;   // middle-click only
    mark(a2.getAttribute('data-bm-id'), a2);
  }
  document.addEventListener('click', onLaunch, true);
  document.addEventListener('auxclick', onLaunch, true);
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    var btn = t && t.closest ? t.closest('button.mark-done') : null;
    if (!btn) return;
    var id = btn.getAttribute('data-bm-id');
    if (launched[id]) { delete launched[id]; persist(); paint(); }
    else mark(id, null);
  });

  // ---- save / restore progress ----
  document.getElementById('save-progress').addEventListener('click', function () {
    var blob = new Blob([JSON.stringify({ schemaVersion: 1, pathwayId: PID, launched: launched }, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a3 = document.createElement('a');
    a3.href = url; a3.download = SLUG + '--progress.json';
    document.body.appendChild(a3); a3.click(); a3.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  });
  var restoreInput = document.getElementById('restore-file');
  document.getElementById('restore-progress').addEventListener('click', function () { restoreInput.click(); });
  restoreInput.addEventListener('change', function () {
    var f = restoreInput.files && restoreInput.files[0];
    restoreInput.value = '';
    if (!f) return;
    if (f.size > 1048576) { notify('That file is too large to be a progress file.'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = JSON.parse(String(reader.result));
        if (!parsed || parsed.schemaVersion !== 1 || !parsed.launched) { notify('Not a PathCurator progress file.'); return; }
        if (String(parsed.pathwayId) !== PID) { notify('That progress file belongs to a different pathway — not restored.'); return; }
        var added = 0;
        for (var k in parsed.launched) {
          if (!Object.prototype.hasOwnProperty.call(parsed.launched, k)) continue;
          if (!validIds[k]) continue;
          var t = Number(parsed.launched[k]);
          if (!isFinite(t) || t <= 0) continue;
          if (!(k in launched)) { launched[k] = t; added++; }   // existing entries win
        }
        persist(); paint();
        notify(added > 0 ? 'Progress restored (' + added + ' added).' : 'Nothing new to restore.');
      } catch (e) { notify('Could not read that file.'); }
    };
    reader.readAsText(f);
  });
  function notify(msg) {
    var n = document.getElementById('search-count');
    n.hidden = false; n.textContent = msg;
    setTimeout(function () { if (n.textContent === msg) { n.hidden = true; n.textContent = ''; } }, 6000);
  }

  // ---- learner-side export: browser bookmarks (Netscape format), built FROM THE DOM at click
  // time — titles/urls/steps are read from the page and escaped, so the static-script guarantee
  // (no per-pathway data in the script) holds. Only http(s) launch links are included.
  document.getElementById('dl-bookmarks').addEventListener('click', function () {
    var esc = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
    var L = [];
    L.push('<!DOCTYPE NETSCAPE-Bookmark-file-1>');
    L.push('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">');
    L.push('<TITLE>Bookmarks</TITLE>');
    L.push('<H1>Bookmarks</H1>');
    L.push('<DL><p>');
    var h1 = document.querySelector('h1');
    L.push('  <DT><H3>' + esc(h1 ? h1.textContent : 'Pathway') + '</H3>');
    L.push('  <DL><p>');
    var steps = document.querySelectorAll('.step');
    for (var i = 0; i < steps.length; i++) {
      var h2 = steps[i].querySelector('summary h2');
      L.push('    <DT><H3>' + esc(h2 ? h2.textContent : 'Step') + '</H3>');
      L.push('    <DL><p>');
      var arts = steps[i].querySelectorAll('article[data-bm-id]');
      for (var a = 0; a < arts.length; a++) {
        var lnk = arts[a].querySelector('a.launch-btn');
        if (!lnk) continue;
        var href = lnk.getAttribute('href') || '';
        if (!/^https?:/i.test(href)) continue;
        var t = arts[a].querySelector('summary h3');
        var added = Number(arts[a].getAttribute('data-added'));
        var addAttr = isFinite(added) && added > 0 ? ' ADD_DATE="' + Math.floor(added / 1000) + '"' : '';
        L.push('      <DT><A HREF="' + esc(href) + '"' + addAttr + '>' + esc(t ? t.textContent : href) + '</A>');
      }
      L.push('    </DL><p>');
    }
    L.push('  </DL><p>');
    L.push('</DL><p>');
    var blob = new Blob([L.join('\n') + '\n'], { type: 'text/html' });
    var url = URL.createObjectURL(blob);
    var a4 = document.createElement('a');
    a4.href = url; a4.download = SLUG + '--bookmarks.html';
    document.body.appendChild(a4); a4.click(); a4.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    notify('Bookmarks file downloaded — import it from your browser’s bookmark manager.');
  });

  // ---- expand / collapse / search ----
  function setAll(open) {
    var ds = document.querySelectorAll('.step > details, article.bm > details');
    for (var i = 0; i < ds.length; i++) { if (open) ds[i].setAttribute('open', 'open'); else ds[i].removeAttribute('open'); }
  }
  function setSteps(open) {
    var ds = document.querySelectorAll('.step > details');
    for (var i = 0; i < ds.length; i++) { if (open) ds[i].setAttribute('open', 'open'); else ds[i].removeAttribute('open'); }
  }
  document.getElementById('expand-all').addEventListener('click', function () { setAll(true); });
  document.getElementById('collapse-all').addEventListener('click', function () { setAll(false); });

  var search = document.getElementById('search');
  search.addEventListener('input', function () {
    var q = search.value.toLowerCase().trim();
    var count = document.getElementById('search-count');
    var prs = document.querySelectorAll('.pause-reflect-section');
    var i;
    if (!q) {
      for (i = 0; i < articles.length; i++) { articles[i].style.display = ''; articles[i].classList.remove('search-hit'); }
      for (i = 0; i < prs.length; i++) prs[i].style.display = '';
      var st0 = document.querySelectorAll('.step');
      for (i = 0; i < st0.length; i++) st0[i].style.display = '';
      count.hidden = true; count.textContent = '';
      return;
    }
    setSteps(true);
    var hits = 0;
    for (i = 0; i < prs.length; i++) prs[i].style.display = 'none';
    for (i = 0; i < articles.length; i++) {
      var match = (articles[i].textContent || '').toLowerCase().indexOf(q) !== -1;
      articles[i].style.display = match ? '' : 'none';
      articles[i].classList.toggle('search-hit', match);
      var det = articles[i].querySelector('details');
      if (det) { if (match) det.setAttribute('open', 'open'); else det.removeAttribute('open'); }
      if (match) hits++;
    }
    var st = document.querySelectorAll('.step');
    for (i = 0; i < st.length; i++) {
      var any = false;
      var arts = st[i].querySelectorAll('article[data-bm-id]');
      for (var a = 0; a < arts.length; a++) if (arts[a].style.display !== 'none') any = true;
      st[i].style.display = any ? '' : 'none';
    }
    count.hidden = false;
    count.textContent = hits + ' matching link' + (hits === 1 ? '' : 's');
  });

  // ---- gear popover: anchor beside the button on open (CSS anchor positioning isn't universal
  // yet); mirror the open state onto the button for styling/AT.
  var gearBtn = document.querySelector('.gear-btn');
  var gearMenu = document.getElementById('gear-menu');
  gearMenu.addEventListener('toggle', function (e) {
    var open = e.newState === 'open';
    gearBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open) return;
    var r = gearBtn.getBoundingClientRect();
    gearMenu.style.top = (r.bottom + 4) + 'px';
    gearMenu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    gearMenu.style.left = 'auto';
  });

  // ---- theme + scroll-to-top ----
  var savedTheme = sGet(THEME_KEY);
  if (savedTheme === 'dark' || savedTheme === 'light') document.documentElement.setAttribute('data-theme', savedTheme);
  document.getElementById('theme-btn').addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-theme');
    var dark = cur ? cur === 'dark' : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var next = dark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    sSet(THEME_KEY, next);
  });
  var toTop = document.getElementById('to-top');
  window.addEventListener('scroll', function () { toTop.hidden = window.scrollY < 400; }, { passive: true });
  toTop.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });

  // ---- SCORM lifecycle: exit=suspend + final commit BEFORE the single LMSFinish. A bfcache
  // restore after Finish re-runs discovery/init; if that fails, the page latches read-only
  // (still fully usable, nothing more is written) rather than silently switching to localStorage.
  window.addEventListener('pagehide', function () {
    if (!scorm || scormFinished) return;
    if (commitTimer) { clearTimeout(commitTimer); commitTimer = null; }
    if (!scorm.readOnly) { scormSet('cmi.core.exit', 'suspend'); try { scorm.api.LMSCommit(''); } catch (e) { } }
    try { scorm.api.LMSFinish(''); } catch (e2) { }
    scormFinished = true;
  });
  window.addEventListener('pageshow', function (ev) {
    if (!ev.persisted || !scorm || !scormFinished) return;
    var re = initScorm();
    if (re) { scorm = re; scormFinished = false; }
    else scorm.readOnly = true;
  });

  // Boot: score bounds once, then the first paint drives the first status write — a fresh
  // attempt reports "incomplete" (or "completed" when nothing is required) immediately, no
  // lingering "not attempted".
  if (scorm && !scorm.readOnly) { scormSet('cmi.core.score.min', '0'); scormSet('cmi.core.score.max', '100'); }
  paint();
})();
`;
