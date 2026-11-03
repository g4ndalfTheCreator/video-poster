import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { migrate } from '../packages/core/src/migrate.js';
import type { Sql } from '../packages/core/src/db.js';

let container: StartedPostgreSqlContainer | undefined;

/**
 * Starts PostgreSQL 16 with Testcontainers (or uses TEST_DATABASE_URL) and builds a migrated
 * template database. Each test file clones it via `createTestDatabase()`.
 */
export default async function setup({ provide }: { provide: (k: string, v: string) => void }) {
  let adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    adminUrl = container.getConnectionUri();
  }
  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  await admin.unsafe('DROP DATABASE IF EXISTS vs_template');
  await admin.unsafe('CREATE DATABASE vs_template');
  await admin.end();
  const tplUrl = withDb(adminUrl, 'vs_template');
  const tpl = postgres(tplUrl, { max: 1, onnotice: () => undefined });
  await migrate(tpl as unknown as Sql, new URL('../packages/core/src/migrations', import.meta.url).pathname);
  await tpl.end();
  provide('pgAdminUrl', adminUrl);
  return async () => {
    await container?.stop();
  };
}

export function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}
