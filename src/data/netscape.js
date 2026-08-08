// src/data/netscape.js — the Netscape Bookmark File format, BOTH WAYS (P7).
// EXPORT: pathway → bookmarks.html importable by any browser (Chrome/Firefox/Safari/Edge), with a
// folder per step nested under a pathway folder. Only http(s) URLs are emitted; text/attributes
// escaped; no comments/raw-text hazards.
// IMPORT: any browser's "Export bookmarks" file → a pathway (folders → steps; nested folders
// flatten to "Parent / Child"; loose links → a "Links" step). Parsed with DOMParser('text/html'),
// which never executes scripts; only textContent + href are read, and the P6 import pipeline's
// safeUrl quarantine still applies downstream. Deterministic ids (bm--<slug>…) so re-importing the
// same file classifies as identical, not duplicates.
import { slugify } from './exchange.js';

const today = () => new Date().toISOString().slice(0, 10);
const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const httpUrl = (u) => { try { const x = new URL(String(u || '')); return (x.protocol === 'http:' || x.protocol === 'https:') ? x.href : null; } catch { return null; } };
const LINK_CAP = 2000;

// ============================== EXPORT ==============================
export async function buildPathwayBookmarks(db, { id }) {
  const d = await db.exportPathwayData(id);
  const p = d.obj.pathway;
  const L = [];
  L.push('<!DOCTYPE NETSCAPE-Bookmark-file-1>');
  L.push('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">');
  L.push('<TITLE>Bookmarks</TITLE>');
  L.push('<H1>Bookmarks</H1>');
  L.push('<DL><p>');
  L.push(`  <DT><H3>${escHtml(p.name)}</H3>`);
  L.push('  <DL><p>');
  for (const s of p.steps || []) {
    L.push(`    <DT><H3>${escHtml(s.name)}</H3>`);
    L.push('    <DL><p>');
    for (const b of s.bookmarks || []) {
      const u = httpUrl(b.url);
      if (!u) continue;                                    // unsafe/non-web URLs never exported
      const add = b.added_at ? ` ADD_DATE="${Math.floor(b.added_at / 1000)}"` : '';
      L.push(`      <DT><A HREF="${escHtml(u)}"${add}>${escHtml(b.title || b.url)}</A>`);
    }
    L.push('    </DL><p>');
  }
  L.push('  </DL><p>');
  L.push('</DL><p>');
  return { content: L.join('\n') + '\n', filename: `${slugify(p.name)}--bookmarks--${today()}.html` };
}

// ============================== IMPORT ==============================
export function looksLikeNetscape(text) {
  const head = String(text).slice(0, 4000);
  return /<!DOCTYPE NETSCAPE-Bookmark/i.test(head) || (/<dl/i.test(head) && /<dt>\s*<a\s[^>]*href=/i.test(head));
}

export function parseNetscapeBookmarks(text, { fallbackName = 'Imported bookmarks' } = {}) {
  const doc = new DOMParser().parseFromString(String(text), 'text/html');   // inert — never executes
  const anchors = [...doc.querySelectorAll('a[href]')];
  if (!anchors.length) throw new Error('No links found in this bookmarks file.');
  if (anchors.length > LINK_CAP) throw new Error(`Too many links in one bookmarks file (${anchors.length} > ${LINK_CAP}).`);

  // Folder path via ancestry: the HTML parser keeps a folder's <DL> inside its <DT>, so walking
  // ancestor DTs (the ones headed by an H3) yields the enclosing folder chain.
  const links = anchors.map((a) => {
    const names = [];
    for (let n = a.parentElement; n && n !== doc.body; n = n.parentElement) {
      if (n.tagName === 'DT') {
        const h = n.querySelector(':scope > h3');
        if (h) names.unshift(h.textContent.trim());
      }
    }
    const dt = a.closest('dt');
    const dd = dt?.nextElementSibling;
    const addDate = Number(a.getAttribute('add_date'));
    return {
      path: names.filter(Boolean),
      title: a.textContent.trim(),
      url: a.getAttribute('href') || '',
      description: dd?.tagName === 'DD' ? dd.textContent.trim() : '',
      added_at: Number.isFinite(addDate) && addDate > 0 ? addDate * 1000 : null,
    };
  });

  // Unwrap folders common to EVERY link (our own export's pathway folder; Chrome's "Bookmarks
  // bar") — the last unwrapped name becomes the pathway name. Never unwrap a level that would
  // leave EVERY link folderless: that level is the steps (e.g. a single-step export).
  let name = fallbackName;
  while (links.every((l) => l.path.length > 0)
    && new Set(links.map((l) => l.path[0])).size === 1
    && !links.every((l) => l.path.length === 1)) {
    name = links[0].path[0];
    for (const l of links) l.path.shift();
  }

  const stepMap = new Map();                               // "A / B" → links, in encounter order
  for (const l of links) {
    const stepName = l.path.length ? l.path.join(' / ') : 'Links';
    if (!stepMap.has(stepName)) stepMap.set(stepName, []);
    stepMap.get(stepName).push(l);
  }

  const id = `bm--${slugify(name)}`;
  const steps = [...stepMap.entries()].map(([stepName, items], si) => ({
    id: `${id}-s${si}`, name: stepName, objective: '', pause_and_reflect: '', sort_order: si,
    bookmarks: items.map((l, bi) => ({
      id: `${id}-s${si}-b${bi}`, title: l.title || l.url, url: l.url,
      description: l.description, context: '', required: 1, content_type: 'Read',
      added_at: l.added_at, sort_order: bi,
    })),
  }));
  return { pathways: [{ schemaVersion: 1, pathway: {
    id, name, description: '', content_warning: '', acknowledgments: '', sort_order: 0,
    created_at: null, last_updated: null, version: null, created_by: null, modified_by: null,
    header_image: null, version_history: [], extra: {}, steps,
  } }], images: {} };
}
