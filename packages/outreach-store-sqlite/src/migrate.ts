import { SCHEMA_0007 } from './schema-0007';
import { SCHEMA_0004 } from './schema-0004';
import { SCHEMA_0006 } from './schema-0006';
import { SCHEMA_0005 } from './schema-0005';
import { sha256Hex, type SqlDatabase } from '@splitin/outreach-contracts';
import { SCHEMA_0001 } from './schema';
import { SCHEMA_0002 } from './schema-0002';
import { SCHEMA_0003 } from './schema-0003';

export interface Migration {
  readonly id: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  { id: '0001_init', sql: SCHEMA_0001 },
  { id: '0002_api_tokens', sql: SCHEMA_0002 },
  { id: '0003_prepared_operations', sql: SCHEMA_0003 },
  { id: '0004_maintenance', sql: SCHEMA_0004 },
  { id: '0005_social_actions', sql: SCHEMA_0005 },
  { id: '0006_browser_actions', sql: SCHEMA_0006 },
  { id: '0007_publishing_workspace', sql: SCHEMA_0007 },
];

export class MigrationDriftError extends Error {
  constructor(id: string) {
    super(`Applied migration ${id} no longer matches its source; never edit an applied migration`);
    this.name = 'MigrationDriftError';
  }
}

/** Applies pending migrations in order, each in its own transaction. Refuses edited migrations. */
export function migrate(db: SqlDatabase, migrations: readonly Migration[] = MIGRATIONS, now = Date.now()): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT`);
  const applied = new Map(
    db
      .prepare('SELECT id, sha256 FROM schema_migrations')
      .all<{ id: string; sha256: string }>()
      .map((row) => [row.id, row.sha256]),
  );
  const ran: string[] = [];
  for (const migration of migrations) {
    const digest = sha256Hex(migration.sql);
    const existing = applied.get(migration.id);
    if (existing !== undefined) {
      if (existing !== digest) throw new MigrationDriftError(migration.id);
      continue;
    }
    // SQLite table rebuilds must disable FK enforcement outside the transaction;
    // validate every reference before commit and restore enforcement on every exit.
    const rebuild = migration.id === '0005_social_actions' || migration.id === '0006_browser_actions';
    const foreignKeys = db.prepare('PRAGMA foreign_keys').get<{ foreign_keys: number }>()?.foreign_keys === 1;
    if (rebuild && foreignKeys) db.exec('PRAGMA foreign_keys = OFF');
    try { db.transaction(() => {
      db.exec(migration.sql);
      if (rebuild && db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('migration foreign key validation failed');
      db.prepare('INSERT INTO schema_migrations (id, sha256, applied_at) VALUES (?,?,?)').run(
        migration.id,
        digest,
        now,
      );
    }); } finally { if (rebuild && foreignKeys) db.exec('PRAGMA foreign_keys = ON'); }
    ran.push(migration.id);
  }
  return ran;
}

