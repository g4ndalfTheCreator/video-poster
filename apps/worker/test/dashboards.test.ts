import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeApp, bootstrapOwner, type TestApp, type Session } from '../../api/test/support.js';
import { seedTelemetry } from '../src/telemetry/seed.js';
import { computeDailyRollups, rebuildAllRollups } from '../src/telemetry/rollups.js';

describe('aggregation and dashboards (100 000 sessions)', () => {
  let t: TestApp;
  let owner: Session;
  let videoIds: string[];
  let linkIds: string[];
  const sql = () => t.ctx.database.sql;
  beforeAll(async () => {
    t = await makeApp();
    owner = await bootstrapOwner(t.app, t.ctx);
    ({ videoIds, linkIds } = await seedTelemetry(sql(), {
      sessions: Number(process.env.DASH_SESSIONS ?? 100_000),
      videos: 5,
      linksPerVideo: 20,
      days: 120,
    }));
  }, 600_000);
  afterAll(() => t.close());

  it('rollups equal the same numbers computed from raw sessions', async () => {
    const tz = 'Europe/Helsinki';
    const raw = await sql()`
      SELECT (s.started_at AT TIME ZONE ${tz})::date::text AS date, s.link_id, count(*)::int AS sessions,
             count(*) FILTER (WHERE ss.unique_watched_ms >= 2000)::int AS views, sum(ss.watch_ms)::bigint AS watch_ms,
             count(*) FILTER (WHERE ss.unique_watched_ms >= 2000 AND ss.completion_pct >= 95)::int AS completions,
             count(DISTINCT coalesce(s.visitor_id::text, s.visitor_hash))::int AS uniques
      FROM view_sessions s JOIN session_summaries ss ON ss.session_id = s.id WHERE NOT s.is_bot GROUP BY 1, 2`;
    const roll =
      await sql()`SELECT date::text, link_id, sessions, views, watch_ms, completions, unique_visitors AS uniques FROM daily_rollups WHERE sessions > 0`;
    const key = (r: Record<string, unknown>) => `${r.date}|${r.link_id}`;
    const m = new Map(roll.map((r) => [key(r), r]));
    expect(roll.length).toBe(raw.length);
    for (const r of raw) {
      const x = m.get(key(r))!;
      expect([x.sessions, x.views, Number(x.watch_ms), x.completions, x.uniques]).toEqual([
        r.sessions,
        r.views,
        Number(r.watch_ms),
        r.completions,
        r.uniques,
      ]);
    }
    // recomputation is idempotent
    const before = await sql()`SELECT sum(sessions)::int AS s, sum(watch_ms)::bigint AS w FROM daily_rollups`;
    await rebuildAllRollups(sql());
    const after = await sql()`SELECT sum(sessions)::int AS s, sum(watch_ms)::bigint AS w FROM daily_rollups`;
    expect(after).toEqual(before);
    expect(await computeDailyRollups(sql(), '2000-01-01', '2000-01-02')).toBe(0);
  }, 300_000);

  it('dashboard endpoints respond within 500 ms', async () => {
    const urls = [
      '/api/admin/analytics/overview',
      `/api/admin/analytics/overview?from=2026-01-01&to=2026-12-31&videoId=${videoIds[0]}`,
      `/api/admin/analytics/videos/${videoIds[0]}`,
      `/api/admin/analytics/links/${linkIds[3]}`,
      '/api/admin/analytics/sessions?pageSize=50',
      '/api/admin/analytics/sessions?pageSize=50&sort=completion&country=FI',
      '/api/admin/analytics/quality',
      '/api/admin/visitors?pageSize=50',
    ];
    for (const url of urls) await t.app.inject({ url, headers: { cookie: owner.cookie } }); // warm-up
    for (const url of urls) {
      const started = performance.now();
      const r = await t.app.inject({ url, headers: { cookie: owner.cookie } });
      const ms = performance.now() - started;
      expect(r.statusCode, `${url}: ${r.body.slice(0, 200)}`).toBe(200);
      expect.soft(ms, url).toBeLessThan(500);
    }
  }, 120_000);

  it('returns sensible dashboard content', async () => {
    const o = (
      await t.app.inject({
        url: '/api/admin/analytics/overview?from=2025-01-01',
        headers: { cookie: owner.cookie },
      })
    ).json();
    expect(o.current.sessions).toBeGreaterThan(90_000);
    expect(o.current.uniqueVisitors).toBeGreaterThan(30_000);
    expect(o.topVideos).toHaveLength(5);
    const v = (
      await t.app.inject({
        url: `/api/admin/analytics/videos/${videoIds[0]}`,
        headers: { cookie: owner.cookie },
      })
    ).json();
    expect(v.retention).toHaveLength(100);
    expect(v.retention[0]).toBeCloseTo(1, 1);
    expect(v.retention[99]).toBeLessThan(v.retention[0]);
    expect(v.dropOffs.length).toBeGreaterThan(0);
    expect(v.byDevice.map((d: { key: string }) => d.key)).toContain('mobile');
    const csv = await t.app.inject({
      url: `/api/admin/analytics/export?view=daily&format=csv&videoId=${videoIds[0]}`,
      headers: { cookie: owner.cookie },
    });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\n')[0]).toContain('date,video_id');
  });
});
