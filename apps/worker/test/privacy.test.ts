import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pino } from 'pino';
import { putSettings, QUEUES } from '@vs/core';
import { makeApp, bootstrapOwner, authed, type TestApp, type Session } from '../../api/test/support.js';
import type { memoryJobs } from '../../api/src/context.js';
import { runRetention } from '../src/jobs/retention.js';

const CHROME =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const log = pino({ level: 'silent' });

/** securityheaders.com-style grading of the response headers that matter for an HTML page. */
export function securityGrade(
  h: Record<string, string | string[] | number | undefined>,
  https: boolean,
): { grade: string; missing: string[] } {
  const need = [
    'content-security-policy',
    'x-content-type-options',
    'x-frame-options',
    'referrer-policy',
    'permissions-policy',
    ...(https ? ['strict-transport-security'] : []),
  ];
  const missing = need.filter((k) => !h[k]);
  const csp = String(h['content-security-policy'] ?? '');
  if (
    csp.includes("'unsafe-inline'") &&
    csp.includes('script-src') &&
    /script-src[^;]*'unsafe-inline'/.test(csp)
  )
    missing.push('csp-unsafe-inline-script');
  return { grade: missing.length === 0 ? 'A' : missing.length <= 2 ? 'B' : 'C', missing };
}

describe('privacy and hardening', () => {
  let t: TestApp;
  let owner: Session;
  let videoId: string;
  const sql = () => t.ctx.database.sql;
  const link = async () =>
    (
      await t.app.inject({
        method: 'POST',
        url: `/api/admin/videos/${videoId}/links`,
        headers: authed(owner),
        payload: { label: 'P' },
      })
    ).json();
  const open = (slug: string, ip = '198.51.100.20') =>
    t.app.inject({
      url: `/v/${slug}`,
      headers: { 'user-agent': CHROME, 'x-forwarded-for': ip, dnt: '1', 'sec-gpc': '1' },
      remoteAddress: '127.0.0.1',
    });
  const cfgOf = (body: string) => JSON.parse(/id="vs-config">(.*?)<\/script>/s.exec(body)![1]!);

  beforeAll(async () => {
    t = await makeApp({ PUBLIC_SCHEME: 'https', PUBLIC_HOST: 'video.example' });
    owner = await bootstrapOwner(t.app, t.ctx);
    const [v] = await sql()<
      { id: string }[]
    >`INSERT INTO videos (id, title, status, hls_version, duration_ms, width, height) VALUES (gen_random_uuid(), 'P', 'ready', 1, 30000, 1280, 720) RETURNING id`;
    videoId = v!.id;
  });
  afterAll(() => t.close());

  it('minimal level stores no raw IP, no user agent and no browser profile', async () => {
    await putSettings(sql(), { telemetry: { level: 'minimal' } });
    const jobs = t.ctx.jobs as ReturnType<typeof memoryJobs>;
    const before = jobs.sent.filter((j) => j.queue === QUEUES.ipEnrich).length;
    const r = await open((await link()).slug);
    const cfg = cfgOf(r.body);
    expect(cfg.telemetry).toBe('off');
    const s = (
      await sql()`SELECT ip, ip_trunc::text AS ip_trunc, user_agent, visitor_hash, os, browser, device_type, dnt, gpc FROM view_sessions WHERE id = ${cfg.sessionId}`
    )[0]!;
    expect(s).toMatchObject({
      ip: null,
      user_agent: null,
      visitor_hash: null,
      os: null,
      browser: null,
      device_type: 'desktop',
      ip_trunc: '198.51.100.0/24',
      dnt: true,
      gpc: true,
    });
    // the SDK is off, but even a forged batch is ignored
    const ingest = await t.app.inject({
      method: 'POST',
      url: '/t/v1/events',
      payload: {
        token: cfg.token,
        events: [{ seq: 0, type: 'fingerprint', client_ts: Date.now(), payload: { signals: { ua: 'x' } } }],
      },
    });
    expect(ingest.statusCode).toBe(204);
    expect((await sql()`SELECT count(*)::int AS n FROM browser_fingerprints`)[0]!.n).toBe(0);
    expect(jobs.sent.filter((j) => j.queue === QUEUES.ipEnrich).length).toBe(before);
    await putSettings(sql(), { telemetry: { level: 'full' } });
  });

  it('does not record sessions from blocklisted addresses', async () => {
    await putSettings(sql(), { blocklist: ['203.0.113.0/24'] });
    const r = await open((await link()).slug, '203.0.113.9');
    expect(r.statusCode).toBe(200);
    const cfg = cfgOf(r.body);
    expect(
      (await sql()`SELECT count(*)::int AS n FROM view_sessions WHERE id = ${cfg.sessionId}`)[0]!.n,
    ).toBe(0);
    expect(cfg.telemetry).toBe('off');
    await putSettings(sql(), { blocklist: [] });
  });

  it('retention drops expired event partitions, clears old profiles and archives segment partitions', async () => {
    await sql()`SELECT ensure_month_partitions('events', 0, 6)`;
    await sql()`SELECT ensure_month_partitions('segment_fetches', 0, 14)`;
    const cfg = cfgOf((await open((await link()).slug)).body);
    const old = new Date(Date.now() - 150 * 86400_000);
    await sql()`INSERT INTO events (session_id, seq, type, server_ts, payload) VALUES (${cfg.sessionId}, 900, 'heartbeat', ${old}, '{}')`;
    await sql()`INSERT INTO events (session_id, seq, type, server_ts, payload) VALUES (${cfg.sessionId}, 901, 'heartbeat', now(), '{}')`;
    await sql()`INSERT INTO segment_fetches (session_id, ts, segment_index, status) VALUES (${cfg.sessionId}, now() - interval '13 months', 1, 200)`;
    await sql()`INSERT INTO browser_fingerprints (fp_hash, stable_hash, signals, last_seen_at) VALUES ('old', 'old', '{"a":1}', now() - interval '200 days')`;
    const oldPart = `events_${old.toISOString().slice(0, 7).replace('-', '')}`;
    expect((await sql()`SELECT to_regclass(${oldPart}) AS r`)[0]!.r).not.toBeNull();

    const r = await runRetention(sql(), log);
    expect(r.droppedEventPartitions).toContain(oldPart);
    expect((await sql()`SELECT to_regclass(${oldPart}) AS r`)[0]!.r).toBeNull();
    expect(
      (await sql()`SELECT seq FROM events WHERE session_id = ${cfg.sessionId} AND seq >= 900`).map(
        (e) => e.seq,
      ),
    ).toEqual([901]);
    expect((await sql()`SELECT signals, fp_hash FROM browser_fingerprints WHERE fp_hash = 'old'`)[0]).toEqual(
      { signals: null, fp_hash: 'old' },
    );
    expect(r.archivedSegmentPartitions.length).toBeGreaterThan(0);
    const archived = r.archivedSegmentPartitions[0]!;
    expect((await sql()`SELECT to_regclass(${'archive.' + archived}) AS r`)[0]!.r).not.toBeNull();
    // server data is kept (default "forever")
    expect(
      (await sql()`SELECT count(*)::int AS n FROM view_sessions WHERE id = ${cfg.sessionId}`)[0]!.n,
    ).toBe(1);
  });

  it('GDPR: finds sessions by IP prefix, exports and hard-deletes them', async () => {
    const l = await link();
    const a = cfgOf((await open(l.slug, '192.0.2.50')).body);
    const b = cfgOf((await open(l.slug, '192.0.2.51')).body);
    await t.app.inject({
      method: 'POST',
      url: '/t/v1/events',
      payload: {
        token: a.token,
        events: [
          { seq: 0, type: 'fingerprint', client_ts: Date.now(), payload: { signals: { ua: 'gdpr' } } },
          { seq: 1, type: 'play', client_ts: Date.now(), payload: { source: 'user' } },
        ],
      },
    });
    const search = await t.app.inject({
      url: '/api/admin/gdpr/search?ip=192.0.2.0/24',
      headers: { cookie: owner.cookie },
    });
    expect(search.json().count).toBe(2);
    const exp = await t.app.inject({
      url: '/api/admin/gdpr/export?ip=192.0.2.50',
      headers: { cookie: owner.cookie },
    });
    expect(exp.json().sessions).toHaveLength(1);
    expect(exp.json().events.length).toBe(2);
    expect(exp.json().browserProfiles).toHaveLength(1);
    const del = await t.app.inject({
      method: 'POST',
      url: '/api/admin/gdpr/delete',
      headers: authed(owner),
      payload: { filter: { ip: '192.0.2.0/24' }, confirm: true },
    });
    expect(del.json()).toMatchObject({ sessions: 2, fingerprints: 1 });
    for (const id of [a.sessionId, b.sessionId]) {
      expect((await sql()`SELECT count(*)::int AS n FROM view_sessions WHERE id = ${id}`)[0]!.n).toBe(0);
      expect((await sql()`SELECT count(*)::int AS n FROM events WHERE session_id = ${id}`)[0]!.n).toBe(0);
      expect(
        (await sql()`SELECT count(*)::int AS n FROM session_summaries WHERE session_id = ${id}`)[0]!.n,
      ).toBe(0);
    }
    const jobs = t.ctx.jobs as ReturnType<typeof memoryJobs>;
    expect(jobs.sent.some((j) => j.queue === QUEUES.rollupsNightly)).toBe(true);
    const actions = await sql()`SELECT action FROM audit_log WHERE action LIKE 'gdpr.%'`;
    expect(actions.map((x) => x.action)).toEqual(
      expect.arrayContaining(['gdpr.search', 'gdpr.export', 'gdpr.delete']),
    );
  });

  it('public and api responses get an A security-header grade over HTTPS', async () => {
    const l = await link();
    for (const r of [
      await open(l.slug),
      await t.app.inject({ url: '/v/nonexistent-1' }),
      await t.app.inject({ url: '/privacy' }),
      await t.app.inject({ url: '/healthz' }),
      await t.app.inject({ url: '/api/admin/auth/state' }),
    ]) {
      const g = securityGrade(r.headers, true);
      expect(g, r.raw.req.url).toEqual({ grade: 'A', missing: [] });
    }
    const page = await open(l.slug);
    expect(page.headers['strict-transport-security']).toContain('max-age=');
    expect(String(page.headers['content-security-policy'])).toMatch(/default-src 'self'/);
    expect(String(page.headers['set-cookie'] ?? '')).toBe('');
  });
});
