// src/ui/views/dashboard.js — pathways grouped by workspace.
import { el, clear, ttButton } from '../dom.js';
import { openPathwayEditor, openWorkspaceEditor, confirmDelete } from '../editors.js';
import { openConnectRepo } from '../connect.js';
import { syncRow } from '../sync-indicator.js';
import { initReorder, reorderControls } from '../reorder.js';
import { openImportDialog } from '../import-dialog.js';
import { downloadFile } from '../download.js';
import { buildExportFile } from '/src/data/exchange.js';
export default async function mount(container, params, ctx) {
  const root = el('div', { class: 'view-content' }); container.append(root);
  let teardownReorder = null;
  const controller = { title: 'Dashboard', refresh, destroy() { teardownReorder?.(); } };
  const btn = (txt, props, fn) => { const b = el('button', { type: 'button', ...props }, txt); b.addEventListener('click', fn); return b; };

  // P6: export any scope to a self-contained file; announce oversized backups honestly.
  async function doExport(scope, id, invoker) {
    try {
      const { filename, content, oversized } = await buildExportFile(ctx.db, { scope, id });
      downloadFile(filename, content);
      ctx.announce(oversized
        ? `Exported ${filename} — WARNING: this file exceeds the import size cap; export workspaces individually instead.`
        : `Exported ${filename}.`);
    } catch (e) { ctx.announce(e.message || 'Export failed.', { assertive: true }); }
  }
  // P6: import via picker or drag-drop — both primary-only (imports are writes).
  const importFile = (file, invoker) => {
    if (!ctx.isPrimary()) { ctx.announce('This tab is read-only — import from the primary tab.', { assertive: true }); return; }
    if (file) openImportDialog({ file, invoker, ctx });
  };
  root.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  root.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    importFile(e.dataTransfer.files[0], null);
  });
  async function refresh() {
    const [workspaces, pathways] = await Promise.all([ctx.db.getWorkspaces(), ctx.db.listPathways()]);
    const primary = ctx.isPrimary();
    const statuses = {};
    if (primary && ctx.sync) await Promise.all(workspaces.map(async (w) => { statuses[w.id] = await ctx.sync._computeStatus(w.id); }));
    const totalUn = Object.values(statuses).reduce((n, s) => n + (s.uncommittedCount || 0), 0);
    const anyConflict = Object.values(statuses).some((s) => s.remoteAhead);
    const byWs = new Map(workspaces.map((w) => [w.id, { ws: w, items: [] }]));
    for (const p of pathways) byWs.get(p.workspace_id)?.items.push(p);
    clear(root);
    root.append(el('h1', { 'data-view-heading': true, tabindex: -1 }, 'Pathways'));
    if (primary) {
      const fileInput = el('input', { type: 'file', accept: 'application/json,.json,text/csv,.csv,text/html,.html', hidden: true, 'data-import-input': true });
      fileInput.addEventListener('change', () => { importFile(fileInput.files?.[0], fileInput); fileInput.value = ''; });
      root.append(el('div', { class: 'dashboard-actions' },
        btn('+ New workspace', { class: 'btn btn--primary', 'data-requires-primary': true, 'data-focus-key': 'new-workspace' },
          (ev) => openConnectRepo({ invoker: ev.currentTarget, ctx })),
        btn('⬆ Import file…', { class: 'btn', 'data-requires-primary': true, 'data-focus-key': 'import-file', title: 'Import a pathway/workspace/backup JSON, legacy export, CSV of links, or browser bookmarks.html (or drag a file onto this page)' },
          () => fileInput.click()),
        btn('⬇ Back up everything', { class: 'btn', 'data-focus-key': 'backup-all' },
          (ev) => doExport('backup', null, ev.currentTarget)),
        fileInput));
    }
    if (primary && (totalUn > 0 || anyConflict)) root.append(el('p', { class: 'sync-summary', role: 'status' },
      anyConflict ? 'Some workspaces have sync conflicts — pull to review.'
        : `${totalUn} uncommitted change${totalUn === 1 ? '' : 's'} across your workspaces.`));
    if (!workspaces.length) { root.append(el('p', { class: 'muted' }, 'No workspaces yet — create one to get started. You can connect it to a GitHub repo now or later. New to PathCurator? ', el('a', { href: '#/help/first-pathway' }, 'Read the five-minute guide'), '.')); return; }
    for (const { ws, items } of byWs.values()) {
      const section = el('section', { class: 'workspace', 'aria-labelledby': `ws-${ws.id}`,
        style: ws.colour ? `--org-accent:${ws.colour}` : null });
      const connected = !!(ws.owner && ws.repo);
      // Connection state renders ONCE: connected → the owner/repo chip (+ sync row below);
      // not connected → a single positive "Connect to GitHub…" button, no warning chips.
      const wsHeader = el('header', {}, el('h2', { id: `ws-${ws.id}` }, `${ws.org_label} `,
        el('span', { class: 'muted' }, `(${ws.pathway_count})`)),
        connected ? el('a', { class: 'ws-conn is-connected', href: `https://github.com/${ws.owner}/${ws.repo}`,
          target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Open ${ws.owner}/${ws.repo} on GitHub` }, `${ws.owner}/${ws.repo} ↗`) : '');
      // Icon toolbar with instant tooltips (same .tt pattern as #/audit; 'end'-aligned so the
      // tips stay on-screen at the right edge).
      if (primary) wsHeader.append(el('span', { class: 'row', style: 'margin-left:auto' },
        ttButton('⬇', 'Export this workspace to a file — every pathway with its images, ready to email or keep as a backup.',
          { class: 'btn btn--icon', 'aria-label': `Export workspace ${ws.org_label} to a file` },
          (ev) => doExport('workspace', ws.id, ev.currentTarget), 'end'),
        connected ? ttButton('⚙', 'Repository & sync settings — change the connected repo, branch, token, or disconnect.',
          { class: 'btn btn--icon', 'aria-label': `Repository and sync settings for ${ws.org_label}`, 'data-requires-primary': true },
          (ev) => openConnectRepo({ workspace: ws, invoker: ev.currentTarget, ctx }), 'end') : '',
        ttButton('✎', 'Rename this workspace and set its accent colour.',
          { class: 'btn btn--icon', 'aria-label': `Rename workspace ${ws.org_label}`, 'data-requires-primary': true },
          (ev) => openWorkspaceEditor({ workspace: ws, invoker: ev.currentTarget, ctx }), 'end'),
        ttButton('🗑', 'Delete this workspace and all its pathways from this device. A connected repository is not touched.',
          { class: 'btn btn--icon btn--danger', 'aria-label': `Delete workspace ${ws.org_label}`, 'data-requires-primary': true },
          (ev) => confirmDelete({ noun: 'workspace', name: `${ws.org_label} (${ws.pathway_count} ${ws.pathway_count === 1 ? 'pathway' : 'pathways'})`,
            invoker: ev.currentTarget, onConfirm: () => ctx.db.deleteWorkspace({ id: ws.id }) }), 'end')));
      section.append(wsHeader);
      if (primary && connected && statuses[ws.id]) section.append(syncRow(ws, statuses[ws.id], ctx));
      else if (primary && !connected) section.append(el('div', { class: 'sync-row' },
        btn('Connect to GitHub…', { class: 'btn btn--sm', 'data-requires-primary': true, 'data-connect-ws': ws.id },
          (ev) => openConnectRepo({ workspace: ws, invoker: ev.currentTarget, ctx }))));
      const list = el('ul', { class: 'card-grid', 'data-reorder-scope': 'pathway', role: 'list' });
      items.forEach((p, idx) => {
        const cell = el('li', { class: 'card-cell', 'data-id': p.id, 'data-focus-key': `pathway-card:${p.id}` },
          el('a', { class: 'card', href: `#/pathway/${encodeURIComponent(p.id)}` },
            el('strong', {}, p.name),
            el('p', { class: 'muted' }, `${p.steps} steps · ${p.bookmarks} links`,
              p.broken ? el('span', { class: 'card-broken' }, ` · ${p.broken} broken`) : '')));
        if (primary) cell.append(el('div', { class: 'card-reorder' },
          reorderControls({ entity: 'pathway', id: p.id, index: idx, count: items.length, label: `pathway “${p.name}”` })));
        list.append(cell);
      });
      section.append(list);
      const add = el('button', { type: 'button', class: 'btn',
        'data-requires-primary': true, 'data-focus-key': `add-pathway:${ws.id}` }, '+ New pathway');
      add.addEventListener('click', (ev) => openPathwayEditor({ workspaceId: ws.id, invoker: ev.currentTarget, ctx }));
      if (!primary) add.disabled = true;
      section.append(add);
      root.append(section);
    }
  }
  await refresh();
  teardownReorder = initReorder(root, ctx);
  return controller;
}
