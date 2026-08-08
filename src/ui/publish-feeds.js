// src/ui/publish-feeds.js — P7: CSV and RSS exports for one pathway (the legacy app's remaining
// publishing formats). Pure text builders over the same exportPathwayData canonical shape.
// Hardening: CSV cells are quoted, quote-doubled, and FORMULA-GUARDED (a leading =+-@ or tab gets a
// leading apostrophe so Excel/Sheets never execute curator data), with a UTF-8 BOM so Excel decodes
// non-ASCII correctly. RSS escapes every text node (no CDATA → no ]]> breakout to think about),
// runs description HTML through the app's markdown sanitizer, guards every <link> with safeUrl, and
// uses stable ids for GUIDs. Attribution (author fields) is opt-in, same setting as the web export.
import { renderMarkdown, safeUrl } from './markdown.js';
import { slugify } from '/src/data/exchange.js';

const today = () => new Date().toISOString().slice(0, 10);
const rfc822 = (ms) => new Date(Number(ms) || Date.now()).toUTCString();
const xml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Sanitized HTML string for feed descriptions (markdown → sanitizer → serialize).
function mdHtml(src) {
  if (!src) return '';
  const d = document.createElement('div');
  d.append(renderMarkdown(src));
  return d.innerHTML;
}

// ============================== CSV ==============================
const cell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;                 // formula-injection guard
  return '"' + s.replace(/"/g, '""') + '"';
};
const row = (...cells) => cells.map(cell).join(',');

export async function buildPathwayCsv(db, { id, attribution = false }) {
  const d = await db.exportPathwayData(id);
  const p = d.obj.pathway;
  const lines = [
    row('Pathway Name', p.name),
    row('Pathway Description', p.description || ''),
    row('Content Warning', p.content_warning || ''),
    row('Version', p.version || ''),
    row('Exported', today()),
  ];
  if (attribution && p.created_by) lines.push(row('Curated By', p.created_by));
  lines.push('', row('Step', 'Title', 'URL', 'Type', 'Required', 'Description', 'Context', 'Added'));
  for (const s of p.steps || []) {
    for (const b of s.bookmarks || []) {
      lines.push(row(s.name, b.title || '', b.url || '', b.content_type || 'Read',
        b.required ? 'Required' : 'Bonus', b.description || '', b.context || '',
        b.added_at ? new Date(b.added_at).toISOString().slice(0, 10) : ''));
    }
  }
  return { content: '\uFEFF' + lines.join('\r\n') + '\r\n', filename: `${slugify(p.name)}--csv--${today()}.csv` };
}

// ============================== RSS 2.0 ==============================
// Channel = pathway, item = bookmark. Custom fields ride a proper namespace (the legacy export used
// bare invalid tags). Deep pathcurator:// links are gone: channel <link> is the connected repo URL
// when known, else omitted. GUIDs are the STABLE ids (survive re-exports; legacy used indexes).
export async function buildPathwayRss(db, { id, attribution = false, siteUrl = null }) {
  const d = await db.exportPathwayData(id);
  const p = d.obj.pathway;
  const site = safeUrl(siteUrl || '');
  const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:pc="https://pathcurator.dev/ns/rss">');
  L.push('<channel>');
  L.push(`  <title>${xml(p.name)}</title>`);
  L.push(`  <description>${xml(mdHtml(p.description))}</description>`);
  if (site) L.push(`  <link>${xml(site)}</link>`);
  L.push(`  <lastBuildDate>${xml(rfc822(Date.now()))}</lastBuildDate>`);
  L.push(`  <pubDate>${xml(rfc822(p.last_updated || p.created_at))}</pubDate>`);
  L.push('  <generator>PathCurator</generator>');
  L.push('  <language>en-us</language>');
  if (p.version) L.push(`  <pc:version>${xml(p.version)}</pc:version>`);
  if (p.content_warning) L.push(`  <pc:contentWarning>${xml(mdHtml(p.content_warning))}</pc:contentWarning>`);
  if (attribution && p.created_by) {
    L.push(`  <managingEditor>${xml(p.created_by)}</managingEditor>`);
    L.push(`  <webMaster>${xml(p.modified_by || p.created_by)}</webMaster>`);
  }
  for (const s of p.steps || []) {
    for (const b of s.bookmarks || []) {
      const link = safeUrl(b.url);
      const desc = [mdHtml(b.description),
        b.context ? `<p><strong>Context:</strong> ${mdHtml(b.context)}</p>` : '',
        s.objective ? `<p><strong>Step objective:</strong> ${mdHtml(s.objective)}</p>` : ''].filter(Boolean).join('');
      L.push('  <item>');
      L.push(`    <title>${xml(b.title || b.url)}</title>`);
      L.push(`    <description>${xml(desc)}</description>`);
      if (link) L.push(`    <link>${xml(link)}</link>`);
      L.push(`    <guid isPermaLink="false">${xml(`${p.id}-${b.id}`)}</guid>`);
      L.push(`    <pubDate>${xml(rfc822(b.added_at || p.created_at))}</pubDate>`);
      L.push(`    <category>${xml(b.content_type || 'Read')}</category>`);
      L.push(`    <pc:stepName>${xml(s.name)}</pc:stepName>`);
      L.push(`    <pc:required>${b.required ? 'Required' : 'Bonus'}</pc:required>`);
      L.push('  </item>');
    }
  }
  L.push('</channel>');
  L.push('</rss>');
  return { content: L.join('\n') + '\n', filename: `${slugify(p.name)}--rss--${today()}.xml` };
}
