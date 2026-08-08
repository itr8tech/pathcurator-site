// PathCurator v2 schema (P1). Validated against real data (2026-07-14):
// content_type enum includes 'Participate'. Secrets live OUTSIDE SQLite (IndexedDB).
export const SCHEMA_VERSION = 1;

// ---- MIGRATIONS ---------------------------------------------------------------------------------
// Keyed by the version the entry PRODUCES: MIGRATIONS[2] upgrades a v1 database to v2.
//
// To ship a schema change: bump SCHEMA_VERSION, add the matching key here, and NEVER edit an entry
// that has shipped — a database that already ran it will not run it again, so an edit only affects
// users who hadn't upgraded yet, which is the worst possible split.
//
// Each value is a list of SQL statements applied in ONE transaction with foreign keys off, followed
// by PRAGMA foreign_key_check. A table rebuild must follow SQLite's 12-step ALTER procedure
// (create new → copy → drop old → rename), because STRICT tables cannot drop or retype a column.
export const MIGRATIONS = {
  // 2: [
  //   `ALTER TABLE pathways ADD COLUMN licence TEXT`,
  //   `UPDATE pathways SET licence = '' WHERE licence IS NULL`,
  // ],
};

/**
 * The ordered versions to apply to get a database from `from` to `to`.
 *
 * Pure by design — no database access — so ordering, gaps and the downgrade refusal are unit
 * testable without standing up SQLite, which is the only way to cover a v1→v3 upgrade path while
 * SCHEMA_VERSION is still 1.
 *
 * Throws on a DOWNGRADE (a database written by a newer build, e.g. a stale service worker serving
 * older code after a deploy, or a rollback). That case must never fall through to "just run it":
 * newer columns the old code cannot see would be dropped on the next write.
 */
export function migrationPlan(from, to = SCHEMA_VERSION, migrations = MIGRATIONS) {
  if (!Number.isInteger(from) || from < 1) throw new Error(`unreadable schema_version: ${JSON.stringify(from)}`);
  if (!Number.isInteger(to) || to < 1) throw new Error(`bad target schema version: ${JSON.stringify(to)}`);
  // Prefixed so the UI can recognise it without matching on prose. See main.js boot().
  if (from > to) throw new Error(`SCHEMA_NEWER: database is at schema v${from}, this build understands v${to}`);
  const steps = [];
  for (let v = from + 1; v <= to; v++) {
    if (!Array.isArray(migrations[v])) throw new Error(`missing migration to schema v${v} (upgrading from v${from})`);
    steps.push(v);
  }
  return steps;
}

/**
 * Apply the plan. Takes an `io` adapter rather than a database handle so the ordering, transaction
 * bracketing and rollback behaviour can be tested against a recording fake — otherwise none of this
 * code would execute until the first real migration ships, which is the worst time to find a bug in
 * it. io = { exec(sql), selectObjects(sql), setVersion(v) }.
 *
 * Each version commits SEPARATELY: a failure part-way leaves the database at the last version that
 * fully applied, never in a half-migrated state.
 */
export function runMigrations(io, { from, to = SCHEMA_VERSION, migrations = MIGRATIONS } = {}) {
  const steps = migrationPlan(from, to, migrations);
  if (!steps.length) return { from, to: from, applied: [] };

  // foreign_keys must be toggled OUTSIDE a transaction — inside one the PRAGMA is a silent no-op —
  // and SQLite's 12-step table-rebuild procedure requires it off. The finally restores it even when
  // a step throws, so a failed upgrade cannot leave FK enforcement disabled for the whole session.
  io.exec('PRAGMA foreign_keys=OFF;');
  try {
    for (const v of steps) {
      io.exec('BEGIN');
      try {
        for (const sql of migrations[v]) io.exec(sql);
        const bad = io.selectObjects('PRAGMA foreign_key_check') || [];
        if (bad.length) throw new Error(`${bad.length} foreign-key violation(s) after the change`);
        io.setVersion(v);
        io.exec('COMMIT');
      } catch (e) {
        try { io.exec('ROLLBACK'); } catch { /* the failure may have rolled back already */ }
        throw new Error(`migration to schema v${v} failed and was rolled back: ${e.message}`);
      }
    }
  } finally {
    io.exec('PRAGMA foreign_keys=ON;');
  }
  return { from, to, applied: steps };
}

export const SCHEMA_SQL = `
CREATE TABLE schema_meta ( key TEXT PRIMARY KEY, value TEXT NOT NULL ) STRICT;

CREATE TABLE workspaces (              -- one connected org GitHub repo (PAT lives in PathCuratorSecrets)
  id TEXT PRIMARY KEY,
  org_label TEXT NOT NULL,
  owner TEXT, repo TEXT,
  branch TEXT NOT NULL DEFAULT 'main',
  path TEXT NOT NULL DEFAULT '',
  username TEXT, colour TEXT,
  sort_order INTEGER NOT NULL,
  created_at INTEGER
) STRICT;

CREATE TABLE attachments (
  id TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes BLOB NOT NULL,
  byte_len INTEGER NOT NULL, sha256 TEXT, created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE pathways (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content_warning TEXT NOT NULL DEFAULT '',
  acknowledgments TEXT NOT NULL DEFAULT '',
  header_image_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL,
  created_at INTEGER, last_updated INTEGER,
  version TEXT, created_by TEXT, modified_by TEXT,
  extra_json TEXT
) STRICT;
CREATE UNIQUE INDEX ux_pathways_order ON pathways(workspace_id, sort_order);

CREATE TABLE steps (
  id TEXT PRIMARY KEY,
  pathway_id TEXT NOT NULL REFERENCES pathways(id) ON DELETE CASCADE,
  name TEXT NOT NULL, objective TEXT NOT NULL DEFAULT '',
  pause_and_reflect TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL, extra_json TEXT
) STRICT;
CREATE INDEX idx_steps_pathway ON steps(pathway_id);
CREATE UNIQUE INDEX ux_steps_order ON steps(pathway_id, sort_order);

CREATE TABLE bookmarks (
  id TEXT PRIMARY KEY,
  step_id TEXT NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '', url TEXT NOT NULL, url_norm TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', context TEXT NOT NULL DEFAULT '',
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0,1)),
  content_type TEXT NOT NULL DEFAULT 'Read' CHECK (content_type IN ('Read','Watch','Listen','Participate')),
  added_at INTEGER, sort_order INTEGER NOT NULL,
  last_checked INTEGER,
  available INTEGER CHECK (available IN (0,1)),
  http_status INTEGER, status_label TEXT, redirect_url TEXT, check_error TEXT,
  requires_auth INTEGER CHECK (requires_auth IN (0,1)),
  check_method TEXT, check_duration INTEGER, extra_json TEXT
) STRICT;
CREATE INDEX idx_bookmarks_step ON bookmarks(step_id);
CREATE UNIQUE INDEX ux_bookmarks_order ON bookmarks(step_id, sort_order);
CREATE INDEX idx_bookmarks_url ON bookmarks(url_norm);
CREATE INDEX idx_bookmarks_audit ON bookmarks(last_checked);

CREATE TABLE version_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pathway_id TEXT NOT NULL REFERENCES pathways(id) ON DELETE CASCADE,
  hash TEXT NOT NULL, timestamp INTEGER NOT NULL,
  step_count INTEGER, bookmark_count INTEGER, modified_by TEXT
) STRICT;
CREATE INDEX idx_history_pathway ON version_history(pathway_id, timestamp DESC);
CREATE TRIGGER trg_version_cap AFTER INSERT ON version_history BEGIN
  DELETE FROM version_history WHERE pathway_id = NEW.pathway_id AND id NOT IN (
    SELECT id FROM version_history WHERE pathway_id = NEW.pathway_id
    ORDER BY timestamp DESC, id DESC LIMIT 10);
END;

CREATE TABLE inbox (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, url_norm TEXT NOT NULL,
  title TEXT, note TEXT, description TEXT,
  image_url TEXT, image_blob_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,
  content_type TEXT DEFAULT 'Read' CHECK (content_type IN ('Read','Watch','Listen','Participate')),
  source TEXT CHECK (source IN ('extension','bookmarklet','share-target','protocol','file','manual')),
  ref TEXT, status TEXT NOT NULL DEFAULT 'unsorted' CHECK (status IN ('unsorted','triaged','dismissed')),
  sort_order INTEGER, created_at INTEGER NOT NULL, triaged_at INTEGER,
  filed_bookmark_id TEXT REFERENCES bookmarks(id) ON DELETE SET NULL
) STRICT;
CREATE UNIQUE INDEX ux_inbox_ref ON inbox(ref);
CREATE INDEX idx_inbox_status ON inbox(status, created_at DESC);

CREATE TABLE exempt_domains ( domain TEXT PRIMARY KEY, reason TEXT NOT NULL DEFAULT '' ) STRICT;
CREATE TABLE settings ( key TEXT PRIMARY KEY, value TEXT ) STRICT;
`;

export const TABLES = ['version_history','bookmarks','steps','pathways','inbox','attachments','exempt_domains','settings','workspaces','schema_meta'];
