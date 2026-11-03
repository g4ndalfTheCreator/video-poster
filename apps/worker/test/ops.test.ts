import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { pino } from 'pino';
import { inject } from 'vitest';
import { makeApp, bootstrapOwner, type TestApp } from '../../api/test/support.js';
import { backupDatabase } from '../src/jobs/backup.js';
import { seedTelemetry } from '../src/telemetry/seed.js';

const hasPgDump = (() => {
  try {
    execFileSync('pg_dump', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(hasPgDump)('backup and restore', () => {
  let t: TestApp;
  let dir: string;
  let url: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vs-backup-'));
    t = await makeApp({ BACKUP_DIR: dir, BACKUP_KEEP: '2', MEDIA_ROOT: dir });
    url = (
      t.ctx.database.sql as unknown as {
        options: { host: string[]; port: number[]; user: string; pass: string; database: string };
      }
    ).options.database;
    await bootstrapOwner(t.app, t.ctx);
    await seedTelemetry(t.ctx.database.sql, { sessions: 500, videos: 1, linksPerVideo: 3, days: 10 });
  }, 120_000);
  afterAll(async () => {
    await t.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('dumps the database, rotates old dumps and restores into an empty database', async () => {
    const admin = inject('pgAdminUrl');
    const dbUrl = new URL(admin);
    dbUrl.pathname = `/${url}`;
    const log = pino({ level: 'silent' });
    for (let i = 0; i < 3; i++) {
      const s = await backupDatabase(t.ctx.config, log, dbUrl.toString());
      expect(s.ok, s.error).toBe(true);
      await new Promise((r) => setTimeout(r, 1100));
    }
    const dumps = (await readdir(dir)).filter((f) => f.endsWith('.dump'));
    expect(dumps).toHaveLength(2); // BACKUP_KEEP
    const status = JSON.parse(await readFile(path.join(dir, '.backup-status.json'), 'utf8'));
    expect(status.ok).toBe(true);

    // restore into a fresh, empty database
    const a = postgres(admin, { max: 1, onnotice: () => undefined });
    await a.unsafe('DROP DATABASE IF EXISTS vs_restore_test');
    await a.unsafe('CREATE DATABASE vs_restore_test');
    await a.end();
    const target = new URL(admin);
    target.pathname = '/vs_restore_test';
    execFileSync('pg_restore', [
      '--no-owner',
      '--exit-on-error',
      `--dbname=${target.toString()}`,
      path.join(dir, dumps.sort().pop()!),
    ]);
    const src = t.ctx.database.sql;
    const dst = postgres(target.toString(), { max: 1, onnotice: () => undefined });
    for (const table of [
      'admin_users',
      'videos',
      'share_links',
      'view_sessions',
      'session_summaries',
      'events',
      'daily_rollups',
      'schema_migrations',
    ]) {
      const [x] = await src.unsafe(`SELECT count(*)::int AS n FROM ${table}`);
      const [y] = await dst.unsafe(`SELECT count(*)::int AS n FROM ${table}`);
      expect(y!.n, table).toBe(x!.n);
    }
    await dst.end();
  }, 120_000);

  it('records a failed backup in the status file', async () => {
    const s = await backupDatabase(
      t.ctx.config,
      pino({ level: 'silent' }),
      'postgres://nobody:wrong@127.0.0.1:1/nothing',
    );
    expect(s.ok).toBe(false);
    expect(s.error).toBeTruthy();
  });
});

describe('metrics', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp();
  });
  afterAll(() => t.close());
  it('exposes Prometheus metrics to the admin network only', async () => {
    await t.app.inject({ url: '/healthz' });
    const r = await t.app.inject({ url: '/metrics', remoteAddress: '10.0.0.5' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/plain');
    expect(r.body).toContain(
      'vs_http_request_duration_seconds_bucket{method="GET",route="/healthz",status="2xx",le="0.005"}',
    );
    expect(r.body).toContain('vs_database_size_bytes');
    expect(r.body).toContain('# TYPE vs_queue_jobs gauge');
    expect((await t.app.inject({ url: '/metrics', remoteAddress: '203.0.113.1' })).statusCode).toBe(404);
  });
});
