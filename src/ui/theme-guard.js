// src/ui/theme-guard.js — FIRST-PAINT theme guard. Loaded as a PLAIN BLOCKING <script src> BEFORE
// the stylesheet so it runs before first paint (no FOUC). MUST NOT be type="module"/defer (those run
// after paint). Extracted from an inline <script> so a strict CSP (script-src 'self') needs no nonce.
// 'pc-theme' present ('light'|'dark') = explicit user choice; ABSENT = follow OS via CSS media query.
(function () {
  try {
    var t = localStorage.getItem('pc-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* private mode → OS default via prefers-color-scheme */ }
})();
