import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Sql } from './db.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const LOCK_ID = 727_001;

/**
 * Applies pending SQL migrations in order, under a Postgres advisory lock so that several
 * api/worker replicas starting at once do not race. Migrations are forward-only.
 */
export async function migrate(
  sql: Sql,
  dir = process.env.MIGRATIONS_DIR ?? MIGRATIONS_DIR,
): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_ID})`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const done = new Set(
      (await tx<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name),
    );
    for (const file of files) {
      if (done.has(file)) continue;
      const body = await readFile(path.join(dir, file), 'utf8');
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      applied.push(file);
    }
  });
  return applied;
}
