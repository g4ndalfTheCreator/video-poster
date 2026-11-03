import { inject } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { createDatabase, loadConfig, type Config, type Database } from '../packages/core/src/index.js';
import { withDb } from './global-setup.js';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

/** Creates a fresh database cloned from the migrated template. */
export async function createTestDatabase(): Promise<{
  database: Database;
  url: string;
  drop: () => Promise<void>;
}> {
  const adminUrl = inject('pgAdminUrl');
  const name = `vs_test_${randomBytes(6).toString('hex')}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE vs_template`);
  await admin.end();
  const url = withDb(adminUrl, name);
  const database = createDatabase(url, { max: 5 });
  return {
    database,
    url,
    drop: async () => {
      await database.close();
      const a = postgres(adminUrl, { max: 1, onnotice: () => undefined });
      await a.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    PUBLIC_HOST: 'video.test',
    PUBLIC_SCHEME: 'http',
    DATABASE_URL: 'postgres://unused',
    MEDIA_ROOT: '/tmp/vs-test-media',
    MEDIA_SIGNING_KEY: 'm'.repeat(40),
    INGEST_SIGNING_KEY: 'i'.repeat(40),
    APP_ENCRYPTION_KEY: 'a'.repeat(64),
    LOG_LEVEL: 'silent',
    TRUSTED_PROXIES: '127.0.0.1/32',
    ...overrides,
  });
}
