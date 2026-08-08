# Link-audit tooling (P5)

PathCurator audits links **outside the app**, because the app's strict CSP
(`connect-src 'self' https://api.github.com`) intentionally blocks it from fetching
arbitrary URLs. The primary checker is a **GitHub Action** that runs in a *pathways*
repo, checks every URL server-side (real HTTP status — no browser CSP), and commits
`audit/results.json`. The app merges that file on its next pull and shows a status
pill on each bookmark. See [`docs/p5-build-spec.md`](../docs/p5-build-spec.md).

## Files

- **`audit.mjs`** — the checker. Node ≥ 20, built-ins only. From a repo root it finds
  every `manifest.json`, checks each bookmark's URL (HEAD → GET fallback on HEAD
  failure, follow redirects, timeout), honours `audit/config.json` exemptions AND
  `audit/overrides.json` curator overrides (see below), and writes
  `<root>/audit/results.json` (keyed by the committed `url_norm`) +
  `<root>/audit/REPORT.md` (human-readable) + a summary on the Action run page.
- **`notify.mjs`** — opens/updates a **GitHub Issue** with the report when there are
  broken links (so GitHub emails repo watchers). Credential-free — the Action's
  built-in token, no secrets. Comments (→ email) only when the broken set changes;
  closes the issue when all links are reachable again.
- **`workflow.yml`** — the GitHub Actions template (runs `audit.mjs` then `notify.mjs`,
  commits `results.json` + `REPORT.md`).

## Notifications

- **GitHub Issue → email** — implemented (`notify.mjs`). Zero setup. "Broken" excludes
  Auth-required (login-walled) and Timeout (verify-manually).
- **MS Teams (wanted, NOT set up yet)** — post the report to a Teams channel via an
  incoming webhook. Deferred: add a workflow step that POSTs `REPORT.md` (as an
  Adaptive Card / MessageCard) to a `TEAMS_WEBHOOK_URL` repo secret, gated on broken
  links > 0. Set up when we're ready to wire the webhook.

## Deploy into a pathways repo

**The app does this for you now**: connecting + initializing a fresh repo installs
`audit/audit.mjs`, `audit/notify.mjs`, and `.github/workflows/audit.yml` automatically,
and `#/audit → Audit workflow → Install / update` does the same for existing repos
(idempotent — re-run it after app updates to refresh the committed copies). Note:
fine-grained PATs need the **Workflows** permission to write under `.github/workflows/`;
without it the app installs the scripts and tells you to add the workflow file (or the
permission) yourself.

Manual alternative:
1. Copy `audit.mjs` + `notify.mjs` to `audit/` in the pathways repo.
2. Copy `workflow.yml` to `.github/workflows/audit.yml`.
3. Commit + push. It runs weekly and on manual dispatch, committing
   `audit/results.json`. The app's `#/audit` "Link-audit exemptions" writes
   `audit/config.json`, which the checker honours.

These live under `audit/` in the app repo as the canonical source; they are **not**
wired as an active workflow here (this repo isn't a pathways repo).

## Result shape

```json
{ "schemaVersion": 1, "generatedAt": 0, "checkMethod": "github-action",
  "results": { "<url_norm>": { "available": 1, "httpStatus": 200, "statusLabel": "OK",
    "redirectUrl": null, "requiresAuth": 0, "checkError": null, "checkedAt": 0, "durationMs": 0 } } }
```
`available` 1 = 2xx/3xx-resolves, 0 = 4xx/5xx/timeout/DNS. `httpStatus` is the real
code (never faked). `statusLabel` ∈ OK / Redirected / Auth required / Not found /
Server error / Timeout / Blocked.

## Curator overrides (`audit/overrides.json`)

Written by the **app** (the `#/audit` view), committed alongside content commits (or on
their own as "Update audit overrides"), merged three-way on pull — so an override made
on one device applies everywhere, and the checker respects it too:

```json
{ "schemaVersion": 1, "updatedAt": 0,
  "overrides": { "<url_norm>": { "available": 1, "method": "pinned", "setAt": 0 } } }
```

- `method: "pinned"` — hard: **never checked**, never expires ("don't ever flag this").
- `method: "manual"` — soft: trusted for **90 days** from `setAt` (`MANUAL_TTL_MS`,
  must match the app's `AUDIT_MANUAL_TTL_MS`), then checking resumes automatically.
- `available` 1 = curator says good; 0 = curator-flagged broken (listed in the report's
  own section, excluded from the Issue notification — the curator already knows).

Overridden URLs are skipped (no request) and omitted from `results.json`; the report
lists them with their pin/expiry so nothing is silently invisible.
