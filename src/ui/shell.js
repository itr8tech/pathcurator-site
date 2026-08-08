// src/ui/shell.js — chrome: header/theme toggle/role banner/skeleton/error pane.
import { el } from './dom.js';
import * as theme from './theme.js';
import { announce } from './a11y.js';

let banner, outlet, toggle;
// The toggle names the mode you'd SWITCH TO (in dark mode it offers "Light mode"), with a sun/moon
// glyph. Because the label flips to describe the action, it is NOT an aria-pressed toggle — the
// accessible name itself carries the state.
function paintThemeToggle() {
  const dark = theme.current() === 'dark';
  toggle.replaceChildren(
    el('span', { class: 'theme-toggle__icon', 'aria-hidden': 'true' }, dark ? '☀️' : '🌙'),
    el('span', { class: 'theme-toggle__label' }, dark ? 'Light mode' : 'Dark mode'));
}
export function init() {
  banner = document.getElementById('role-banner');
  outlet = document.getElementById('view');
  toggle = document.getElementById('theme-toggle');
  toggle.removeAttribute('aria-pressed');
  paintThemeToggle();
  toggle.addEventListener('click', () => {
    const t = theme.toggle();
    paintThemeToggle();
    announce(t === 'dark' ? 'Dark mode on' : 'Light mode on');
  });
  return { setRole, setBusy, announce, skeleton, errorPane, capabilityScreen, paintThemeToggle };
}
export function setRole(role, isPrimary) {
  document.body.dataset.role = role;                 // ONE role location: body[data-role]
  // Primary is the NORMAL state — no banner for it. Only the exceptional read-only follower
  // state gets announced.
  if (role === 'pending' || isPrimary) { banner.hidden = true; return; }
  banner.hidden = false;
  banner.dataset.kind = 'follower';
  banner.className = 'banner banner--follower';
  banner.textContent = 'Read-only — PathCurator is active in another tab. Editing is disabled here.';
}
export function setBusy(b) { outlet.setAttribute('aria-busy', String(b)); }
export function skeleton() {
  const wrap = el('div', { class: 'view-content', 'aria-hidden': 'true' });
  for (let i = 0; i < 4; i++) wrap.append(el('div', { class: 'skeleton skeleton--line', style: `width:${70 - i * 8}%` }));
  return wrap;
}
export function errorPane(msg) {
  return el('div', { class: 'view-content' },
    el('h1', { 'data-view-heading': true, tabindex: -1 }, 'Something went wrong'),
    el('p', {}, msg),
    el('p', {}, el('a', { href: '#/' }, 'Return to the dashboard')));
}

// Shown when the app can't run here. Diagnosed by LIKELIEST CAUSE (main.js picks the kind):
//   insecure   — plain http:// on a non-localhost origin (the everything-is-disabled case)
//   storage    — secure context but OPFS refused: private window / locked-down profile
//   oldbrowser — WebAssembly/Workers truly absent: ancient browser OR policy-disabled
// Practically every current browser supports the features — so a bare "unsupported browser"
// message is almost always wrong; lead with the environmental causes instead. (O11 / spec §6.4.)
const CAPABILITY_HEADING = {
  framed: 'PathCurator can’t run inside a frame',
  'schema-newer': 'This copy of PathCurator is out of date',
  'migration-failed': 'PathCurator couldn’t finish updating your data',
};
export function capabilityScreen({ kind = 'storage', detail = '' } = {}) {
  const card = el('div', { class: 'capability card', role: 'alert' },
    el('h1', { 'data-view-heading': true, tabindex: -1 },
      CAPABILITY_HEADING[kind] || 'PathCurator can’t save data here'));
  if (kind === 'schema-newer') {
    // The database was written by a NEWER build than the one running — a service worker still
    // serving cached code after a deploy, or a rollback. Refusing is the whole point: older code
    // cannot see newer columns and would drop them on the next write. Lead with "your data is
    // fine", because the alarming reading is that something ate it.
    card.append(
      el('p', {}, 'Your pathways were last opened by a newer version of PathCurator than the one running right now. To avoid damaging them, PathCurator has not opened the database.'),
      el('p', {}, el('strong', {}, 'Nothing is lost.'), ' Your data is exactly as you left it — this copy of the app is simply behind it.'),
      el('p', {}, 'Reload the page to pick up the current version. If that doesn’t help, close every PathCurator tab and open it again — an offline copy of the old app can keep being served until the last tab is gone.'));
  } else if (kind === 'migration-failed') {
    // A version step threw and was rolled back, so the database is still on the last version that
    // fully applied. Say that plainly and point at the export, which still works.
    card.append(
      el('p', {}, 'PathCurator started upgrading your database to a newer format and stopped part-way. The change was undone.'),
      el('p', {}, el('strong', {}, 'Your data has not been altered.'), ' It is still in the format it was in before the attempt.'),
      el('p', {}, 'Reload to try again. If it keeps failing, report this with the message below — and note that GitHub sync and “Back up everything” still work from an older version of the app if you need a copy first.'),
      detail ? el('pre', { class: 'capability__detail' }, detail) : null);
  } else if (kind === 'framed') {
    // Clickjacking (frame-guard.js). Assume the visitor is the VICTIM, not the embedder: say what
    // happened in plain language and hand them a safe way out. target="_top" supplies the user
    // activation that the guard's automatic escape attempt lacked.
    card.append(
      el('p', {}, 'Another site has embedded PathCurator inside a frame on its own page. PathCurator refuses to run that way, because a frame can hide what you are really clicking on — and this app can commit to your repositories and delete your work.'),
      el('p', {}, el('strong', {}, 'Nothing has happened to your data.'), ' It is stored in your browser and was never opened here.'),
      el('p', {}, el('a', { href: location.href, target: '_top', rel: 'noopener' }, 'Open PathCurator directly'),
        ' — or type the address into your address bar yourself, which is always the safest option.'));
  } else if (kind === 'insecure') {
    card.append(
      el('p', {}, 'You’re viewing PathCurator over an insecure connection (', el('code', {}, `http://${location.host}`),
        '). Browsers only unlock on-device storage — where PathCurator keeps your pathways — on ',
        el('strong', {}, 'HTTPS'), ' pages (or on localhost during development).'),
      el('p', {}, el('strong', {}, 'Open the https:// address for this app instead.'),
        ' The browser itself is fine — it’s the connection that’s the blocker.'));
  } else if (kind === 'oldbrowser') {
    card.append(
      el('p', {}, 'This browser has no WebAssembly or Web Worker support, which PathCurator needs to run its on-device database.'),
      el('p', {}, 'Every current browser (Chrome/Edge, Firefox, Safari) supports these — so this usually means a ',
        el('strong', {}, 'very old browser'), ' or a ', el('strong', {}, 'managed system'),
        ' where security policy has disabled WebAssembly. Try a current browser, or check with whoever administers this machine.'));
  } else {
    card.append(
      el('p', {}, 'Your browser refused access to on-device storage — PathCurator keeps your pathways in the browser’s private file system, and it isn’t available here. The usual reasons:'),
      el('ul', {},
        el('li', {}, el('strong', {}, 'Private / Incognito window'), ' — the most common cause; private windows block or discard this storage. Open PathCurator in a normal window.'),
        el('li', {}, el('strong', {}, 'A locked-down or managed browser'), ' — a workplace policy or a “block site data” privacy setting can disable it. Check with your administrator or allow site data for this site.'),
        el('li', {}, el('strong', {}, 'A very old browser'), ' — needs Chrome/Edge 108+, Firefox 111+, or Safari 16.4+; every current version qualifies, so this is the least likely.')),
      el('p', {}, 'Nothing is lost — your data lives wherever you normally use PathCurator, not here.'),
      el('p', { class: 'muted' }, 'Once you are set up, GitHub sync and JSON export are your off-device backups.'));
  }
  return el('div', { class: 'view-content' }, card);
}
