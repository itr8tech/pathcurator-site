// src/ui/legacy-rescue.js — the dashboard offer that surfaces PathCurator v1 data found in this
// browser (see src/data/legacy-idb.js for why it would otherwise be invisible).
//
// Deliberately an OFFER, not an automatic import: the user's v1 database is theirs, the import
// creates a workspace, and doing that silently on first load would be a surprise write. The answer
// is remembered either way so the dashboard does not nag.
import { el } from './dom.js';
import { readLegacyPathways, summarise } from '/src/data/legacy-idb.js';

const STATE_KEY = 'legacy_idb_state';        // 'imported' | 'dismissed' — unset means "still ask"
const WORKSPACE_NAME = 'Imported from PathCurator';

/**
 * → a banner element, or null when there is nothing to offer. Never throws; a failure here must not
 * take the dashboard down with it.
 * @param onDone called after a successful import so the dashboard can re-render.
 */
export async function legacyRescueBanner(ctx, onDone) {
  try {
    if (!ctx.isPrimary()) return null;                       // importing is a write → primary only
    if (await ctx.db.getSetting(STATE_KEY)) return null;      // already imported or dismissed
    const { found, pathways: rows } = await readLegacyPathways();
    if (!found) return null;

    const { pathways, links } = summarise(rows);
    const card = el('section', { class: 'card legacy-rescue', role: 'status', 'data-legacy-rescue': true },
      el('h2', {}, 'Pathways from your previous version'),
      el('p', {}, `This browser still holds ${pathways} pathway${pathways === 1 ? '' : 's'}`,
        links ? ` and ${links} link${links === 1 ? '' : 's'}` : '',
        ' saved by the older version of PathCurator. Import them and they become a normal workspace here.'),
      el('p', { class: 'muted' }, 'Your old data is left untouched either way — importing copies it, it does not move it.'));

    const status = el('p', { class: 'field-error', role: 'alert' });
    const importBtn = el('button', { type: 'button', class: 'btn btn--primary', 'data-focus-key': 'legacy-import' }, `Import ${pathways} pathway${pathways === 1 ? '' : 's'}`);
    const dismissBtn = el('button', { type: 'button', class: 'btn' }, 'Not now');

    importBtn.addEventListener('click', async () => {
      importBtn.disabled = dismissBtn.disabled = true;
      importBtn.textContent = 'Importing…';
      try {
        // Reuse the EXISTING v1 converter — v1's IndexedDB records are the same shape it already
        // handles from curator-pathways.json, so there is no second conversion path to keep honest.
        const { convertLegacyPathways } = await import('/src/data/legacy.js');
        const { pathways: converted, images } = await convertLegacyPathways(rows);
        const ws = await ctx.db.createWorkspace({ org_label: WORKSPACE_NAME });
        const wsId = ws?.id ?? ws;
        await ctx.db.importPathwaysIntoWorkspace({ workspaceId: wsId, pathways: converted, images });
        await ctx.db.setSetting(STATE_KEY, 'imported');
        ctx.announce(`Imported ${converted.length} pathway${converted.length === 1 ? '' : 's'} from your previous version of PathCurator.`);
        onDone?.();
      } catch (e) {
        // Leave the offer on screen and the setting unset: the v1 data is untouched, so retrying is
        // always safe and is the right next move.
        importBtn.disabled = dismissBtn.disabled = false;
        importBtn.textContent = `Import ${pathways} pathway${pathways === 1 ? '' : 's'}`;
        status.textContent = `Import failed: ${e.message || e}. Your old data is unchanged — you can try again.`;
        ctx.announce('Import failed.', { assertive: true });
      }
    });

    dismissBtn.addEventListener('click', async () => {
      try { await ctx.db.setSetting(STATE_KEY, 'dismissed'); } catch { /* re-offer next time */ }
      card.remove();
      ctx.announce('Import offer dismissed. Your previous version’s data is still in this browser.');
    });

    card.append(el('div', { class: 'row' }, importBtn, dismissBtn), status);
    return card;
  } catch {
    return null;
  }
}
