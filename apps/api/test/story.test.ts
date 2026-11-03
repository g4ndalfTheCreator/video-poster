import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { gzipSync } from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { makeApp, bootstrapOwner, authed, loginViewer, type TestApp, type Session } from './support.js';
import type { memoryJobs } from '../src/context.js';

const PHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const DIST = path.resolve(import.meta.dirname, '../../../packages/player/dist');

describe('story mode', () => {
  let t: TestApp;
  let owner: Session;
  let videoId: string;
  const sql = () => t.ctx.database.sql;
  const link = async (body: Record<string, unknown> = {}) =>
    (
      await t.app.inject({
        method: 'POST',
        url: `/api/admin/videos/${videoId}/links`,
        headers: authed(owner),
        payload: { label: 'S', ...body },
      })
    ).json();
  const open = (slug: string) =>
    t.app.inject({ url: `/v/${slug}`, headers: { 'user-agent': PHONE, 'accept-language': 'fi' } });
  const cfgOf = (b: string) => JSON.parse(/id="vs-config">(.*?)<\/script>/s.exec(b)![1]!);

  beforeAll(async () => {
    t = await makeApp();
    owner = await bootstrapOwner(t.app, t.ctx);
    const [v] = await sql()<{ id: string }[]>`
      INSERT INTO videos (id, title, status, hls_version, duration_ms, width, height) VALUES (gen_random_uuid(), 'Story', 'ready', 1, 30000, 720, 1280) RETURNING id`;
    videoId = v!.id;
    await sql()`INSERT INTO assets (video_id, kind, path, mime, size_bytes, label, filename) VALUES (${videoId}, 'attachment', 'assets/x/cv.pdf', 'application/pdf', 120000, 'CV', 'cv.pdf')`;
  });
  afterAll(() => t.close());

  it('video setting with chapters enables the story layout; links can override it', async () => {
    const r = await t.app.inject({
      method: 'PATCH',
      url: `/api/admin/videos/${videoId}`,
      headers: authed(owner),
      payload: {
        storyMode: true,
        chapters: [
          { atMs: 12000, title: 'Kokemus' },
          { atMs: 0, title: 'Kuka olen' },
        ],
      },
    });
    expect(r.statusCode, r.body).toBe(200);
    const v = (
      await t.app.inject({ url: `/api/admin/videos/${videoId}`, headers: { cookie: owner.cookie } })
    ).json();
    expect(v).toMatchObject({
      storyMode: true,
      chapters: [
        { atMs: 0, title: 'Kuka olen' },
        { atMs: 12000, title: 'Kokemus' },
      ],
    });

    const page = await open((await link()).slug);
    expect(page.body).toContain('class="vs-story"');
    expect(page.body).toContain('id="vs-docs"');
    expect(page.body).toContain('Oliko tämä hyvä tapa tutustua minuun?');
    expect(page.body.match(/data-feedback=/g)).toHaveLength(2); // card + documents page
    expect(page.body).toMatch(/<a class="vs-doc" href="\/api\/public\/links\/[^"]+\/attachments\//);
    expect(cfgOf(page.body)).toMatchObject({
      story: { chapters: [{ title: 'Kuka olen' }, { title: 'Kokemus' }] },
      autoplayMuted: true,
    });

    const classic = await link({ storyMode: false });
    expect((await open(classic.slug)).body).not.toContain('vs-story');
    expect(classic.storyMode).toBe(false);
    // viewers cannot change it
    const viewer = await loginViewer(t.app, owner);
    expect(
      (
        await t.app.inject({
          method: 'PATCH',
          url: `/api/admin/videos/${videoId}`,
          headers: authed(viewer),
          payload: { storyMode: false },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('stores one feedback answer per session, notifies on comments and shows up in analytics', async () => {
    const l = await link();
    const cfg = cfgOf((await open(l.slug)).body);
    const post = (body: Record<string, unknown>) =>
      t.app.inject({ method: 'POST', url: '/t/v1/feedback', payload: { token: cfg.token, ...body } });
    expect((await post({ rating: 'great' })).statusCode).toBe(400);
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/t/v1/feedback',
          payload: { token: 'x'.repeat(40), rating: 'up' },
        })
      ).statusCode,
    ).toBe(401);
    expect((await post({ rating: 'meh' })).statusCode).toBe(204);
    expect((await post({ rating: 'up', comment: '  Tosi hyvä idea!  ' })).statusCode).toBe(204);
    const rows = await sql()`SELECT rating, comment FROM feedback WHERE session_id = ${cfg.sessionId}`;
    expect(rows).toEqual([{ rating: 'up', comment: 'Tosi hyvä idea!' }]);
    const jobs = (t.ctx.jobs as ReturnType<typeof memoryJobs>).sent;
    expect(jobs.some((j) => j.queue === 'notify' && (j.data as { kind: string }).kind === 'feedback')).toBe(
      true,
    );

    // documents reached by swiping
    await t.app.inject({
      method: 'POST',
      url: '/t/v1/events',
      payload: {
        token: cfg.token,
        events: [{ seq: 0, type: 'story_documents', client_ts: Date.now(), payload: { via: 'swipe' } }],
      },
    });
    const s = (
      await t.app.inject({
        url: `/api/admin/analytics/sessions/${cfg.sessionId}`,
        headers: { cookie: owner.cookie },
      })
    ).json();
    expect(s).toMatchObject({
      reachedDocuments: true,
      documentsVia: 'swipe',
      feedback: { rating: 'up', comment: 'Tosi hyvä idea!' },
    });
    const va = (
      await t.app.inject({ url: `/api/admin/analytics/videos/${videoId}`, headers: { cookie: owner.cookie } })
    ).json();
    expect(va.story.feedback.up).toBeGreaterThanOrEqual(1);
    expect(va.story.comments[0].comment).toBe('Tosi hyvä idea!');
    expect(va.story.documentsVia.swipe).toBe(1);
    const rec = (
      await t.app.inject({ url: `/api/admin/analytics/links/${l.id}`, headers: { cookie: owner.cookie } })
    ).json();
    expect(rec.sessions[0]).toMatchObject({ feedbackRating: 'up', reachedDocuments: true });
    const gdpr = (
      await t.app.inject({ url: `/api/admin/gdpr/export?linkId=${l.id}`, headers: { cookie: owner.cookie } })
    ).json();
    expect(gdpr.feedback).toHaveLength(1);
  });

  it.runIf(existsSync(path.join(DIST, 'story.js')))(
    'story page + player + SDK stay under 120 kB gzip',
    async () => {
      const page = await open((await link()).slug);
      const total = [
        Buffer.from(page.body),
        readFileSync(path.join(DIST, 'story.js')),
        readFileSync(path.join(DIST, 'base.css')),
        readFileSync(path.join(DIST, 'story.css')),
      ]
        .map((b) => gzipSync(b).length)
        .reduce((a, b) => a + b, 0);
      expect(gzipSync(Buffer.from(page.body)).length).toBeLessThan(3072);
      expect(total).toBeLessThanOrEqual(120 * 1024);
    },
  );
});
