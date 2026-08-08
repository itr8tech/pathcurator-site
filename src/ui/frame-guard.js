// src/ui/frame-guard.js — CLICKJACKING guard, and the one security control that has to live in
// JavaScript. The correct fix is a response header (`X-Frame-Options: DENY` / CSP
// `frame-ancestors 'none'`) and serve.mjs does send it — but production is GitHub Pages, which
// cannot set headers at all, and `frame-ancestors` is IGNORED inside a <meta> CSP. So on the real
// host this script is the only thing standing between the app and a hostile frame.
//
// Why it matters here specifically: PathCurator holds a per-workspace GitHub PAT vault and has
// one-click irreversible actions (delete workspace, delete pathway, discard edits, commit). Those
// are exactly the controls a clickjacker baits clicks onto.
//
// Loaded as a PLAIN BLOCKING <script src> FIRST in <head> — before the stylesheet and before
// main.js — so a framed load never paints anything clickable. MUST NOT be type="module"/defer
// (those run after paint, which is far too late for this).
//
// NOT applied to the published artifact (publish-html.js): that page is DESIGNED to be framed —
// an LMS runs it inside an iframe, which is the entire point of the SCORM slice. Different file,
// different threat model. Nor to /add/, which the bookmarklet opens via window.open() — a popup
// is a TOP-LEVEL context, so this check is false there and capture keeps working.
(function () {
  var framed;
  // A cross-origin ancestor makes even READING window.top throw — and that throw is itself proof
  // of framing, so it must fail closed, never open.
  try { framed = window.self !== window.top; } catch (e) { framed = true; }
  if (!framed) return;

  // 1. Nothing paints, so nothing can be baited into a click — this holds even if main.js never
  //    runs (slow network, module error). main.js clears it to render the explanation.
  document.documentElement.style.display = 'none';
  // 2. The flag main.js reads to show the framed screen instead of booting the database.
  window.__pcFramed = true;
  // 3. Best-effort escape into a real top-level tab. Browsers block cross-origin top navigation
  //    without user activation, so this usually no-ops — which is why (2) renders a screen with a
  //    target="_top" link the user can click, supplying the activation this call lacks.
  try { if (window.top) window.top.location.replace(window.location.href); } catch (e) { /* blocked — expected */ }
})();
