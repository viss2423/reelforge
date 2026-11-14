/**
 * Forward-only schema migrations. Each entry runs once inside a transaction and is recorded
 * in `migrations`. Never edit a shipped migration — append a new one.
 */
import type { DatabaseSync } from 'node:sqlite'

export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: /* sql */ `
      CREATE TABLE projects (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        revision       INTEGER NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        duration       INTEGER NOT NULL DEFAULT 0,
        thumb_asset_id TEXT,
        data           TEXT NOT NULL
      ) STRICT;
      CREATE INDEX projects_updated_at ON projects (updated_at DESC);

      CREATE TABLE assets (
        id         TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        data       TEXT NOT NULL
      ) STRICT;
      CREATE INDEX assets_created_at ON assets (created_at DESC);

      CREATE TABLE jobs (
        id          TEXT PRIMARY KEY,
        seq         INTEGER NOT NULL,
        kind        TEXT NOT NULL,
        status      TEXT NOT NULL,
        priority    INTEGER NOT NULL,
        attempts    INTEGER NOT NULL DEFAULT 0,
        project_id  TEXT,
        asset_id    TEXT,
        created_at  TEXT NOT NULL,
        finished_at TEXT,
        payload     TEXT NOT NULL DEFAULT '{}',
        data        TEXT NOT NULL
      ) STRICT;
      CREATE INDEX jobs_status ON jobs (status, priority, seq);
      CREATE INDEX jobs_project ON jobs (project_id, created_at DESC);
      CREATE INDEX jobs_asset ON jobs (asset_id, created_at DESC);
      CREATE INDEX jobs_finished ON jobs (finished_at);

      CREATE TABLE devices (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        token_hash   BLOB NOT NULL UNIQUE,
        user_agent   TEXT,
        created_at   TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE uploads (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        mime       TEXT NOT NULL,
        size       INTEGER NOT NULL,
        chunk_size INTEGER NOT NULL,
        chunks     INTEGER NOT NULL,
        received   BLOB NOT NULL,
        device_id  TEXT REFERENCES devices (id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `,
  },
]

/** Applies pending migrations; returns the versions that were applied. */
export const migrate = (
  db: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS,
): number[] => {
  db.exec(
    'CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT',
  )
  const done = new Set(
    db
      .prepare('SELECT version FROM migrations')
      .all()
      .map((r) => Number(r.version)),
  )
  const applied: number[] = []
  const record = db.prepare('INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)')
  for (const m of migrations.toSorted((a, b) => a.version - b.version)) {
    if (done.has(m.version)) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(m.sql)
      record.run(m.version, m.name, new Date().toISOString())
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(`migration ${m.version} (${m.name}) failed: ${(err as Error).message}`, {
        cause: err,
      })
    }
    applied.push(m.version)
  }
  return applied
}
