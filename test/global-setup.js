import { PostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { migrate } from '../packages/core/src/migrate.js';
let container;
/**
 * Starts PostgreSQL 16 with Testcontainers (or uses TEST_DATABASE_URL) and builds a migrated
 * template database. Each test file clones it via `createTestDatabase()`.
 */
export default async function setup({ provide }) {
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
  await migrate(tpl, new URL('../packages/core/src/migrations', import.meta.url).pathname);
  await tpl.end();
  provide('pgAdminUrl', adminUrl);
  return async () => {
    await container?.stop();
  };
}
export function withDb(url, db) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}
//# sourceMappingURL=global-setup.js.map
