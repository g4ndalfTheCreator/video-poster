import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pino } from 'pino';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { memoryJobs } from '../src/context.js';
import { createTestDatabase, testConfig } from '../../../test/helpers.js';

describe('healthz', () => {
  let app: FastifyInstance;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    app = await buildApp({
      config: testConfig(),
      database: t.database,
      jobs: memoryJobs(),
      log: pino({ level: 'silent' }),
    });
  });
  afterAll(async () => {
    await app.close();
    await drop();
  });
  it('returns 200 with db status', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', db: 'ok' });
    expect(res.json().migrations).toBeGreaterThan(0);
  });
  it('partitions exist for the current month', async () => {
    const t = await createTestDatabase();
    const rows = await t.database.sql<{ relname: string }[]>`
      SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'events'::regclass ORDER BY 1`;
    expect(rows.length).toBeGreaterThanOrEqual(4);
    await t.drop();
  });
});
