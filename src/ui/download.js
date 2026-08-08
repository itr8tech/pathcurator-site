// src/ui/download.js — the one Blob + a[download] helper (CSP-clean, no server). Moved out of
// import-dialog.js (P7 decision 7) so export paths don't depend on the import dialog, and so the
// mime is honest per artifact (text/html for web exports, application/json for data files).
import { el } from './dom.js';

export function downloadFile(filename, content, mime = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
