import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeApp, bootstrapOwner, authed, loginViewer, type TestApp, type Session } from './support.js';

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

describe('links and watch page', () => {
  let t: TestApp;
  let owner: Session;
  let videoId: string;
  const sql = () => t.ctx.database.sql;
  const view = (slug: string, headers: Record<string, string> = {}) =>
    t.app.inject({
      url: `/v/${slug}`,
      headers: { 'user-agent': CHROME, 'accept-language': 'fi-FI,fi;q=0.9', ...headers },
    });
  const createLink = async (body: Record<string, unknown>) => {
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/admin/videos/${videoId}/links`,
      headers: authed(owner),
      payload: body,
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json();
  };

  beforeAll(async () => {
    t = await makeApp({ PUBLIC_HOST: 'video.test' });
    owner = await bootstrapOwner(t.app, t.ctx);
    const [v] = await sql()<{ id: string }[]>`
      INSERT INTO videos (id, title, description, status, hls_version, duration_ms, width, height, cta_config)
      VALUES (gen_random_uuid(), 'CV-video', 'Hei, olen Whale.', 'ready', 1, 60000, 1920, 1080,
              '[{"id":"cv","label":"Lataa CV","href":"https://example.com/cv.pdf"}]') RETURNING id`;
    videoId = v!.id;
  });
  afterAll(() => t.close());

  it('creates links with random 12-char slugs and validates custom slugs', async () => {
    const l = await createLink({
      label: 'Yritys X / rekrytoija',
      recipientName: 'Maija',
      recipientOrg: 'Yritys X',
    });
    expect(l.slug).toMatch(/^[0-9A-Za-z]{12}$/);
    expect(l.url).toBe(`http://video.test/v/${l.slug}`);
    expect(l.state).toBe('active');

    const custom = await createLink({ label: 'custom', slug: 'whale-cv' });
    expect(custom.guessable).toBe(true);
    const dup = await t.app.inject({
      method: 'POST',
      url: `/api/admin/videos/${videoId}/links`,
      headers: authed(owner),
      payload: { label: 'x', slug: 'whale-cv' },
    });
    expect(dup.statusCode).toBe(409);
    const reserved = await t.app.inject({
      method: 'POST',
      url: `/api/admin/videos/${videoId}/links`,
      headers: authed(owner),
      payload: { label: 'x', slug: 'admin' },
    });
    expect(reserved.statusCode).toBe(400);
    const check = await t.app.inject({
      url: '/api/admin/slugs/check?slug=whale-cv',
      headers: { cookie: owner.cookie },
    });
    expect(check.json()).toMatchObject({ ok: true, guessable: true, available: false });
    expect(check.json().suggestion).toMatch(/^whale-cv-[a-z0-9]{4}$/);
  });

  it('renders the watch page with OG tags, security headers and player config', async () => {
    const l = await createLink({ label: 'page' });
    const r = await view(l.slug);
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(r.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.body).toContain('<html lang="fi">');
    expect(r.body).toContain('<meta property="og:title" content="CV-video">');
    expect(r.body).toMatch(
      /og:image" content="http:\/\/video\.test\/media\/[A-Za-z0-9_-]{22}\/\d+\/0{8}-0{4}-0{4}-0{4}-0{12}\/.+\/poster\.jpg"/,
    );
    expect(r.body).toContain(
      '<meta name="robots" content="noindex">'.replace('noindex', 'noindex, nofollow'),
    );
    expect(r.body).toContain('Lataa CV');
    const cfg = JSON.parse(
      /<script type="application\/json" id="vs-config">(.*?)<\/script>/s.exec(r.body)![1]!,
    );
    expect(cfg.master).toMatch(
      new RegExp(`^/media/[A-Za-z0-9_-]{22}/\\d+/${cfg.sessionId}/${videoId}/1/master.m3u8$`),
    );
    expect(cfg.telemetry).toBe('full');
    const s = await sql()`SELECT * FROM view_sessions WHERE id = ${cfg.sessionId}`;
    expect(s[0]).toMatchObject({
      link_id: l.id,
      device_type: 'desktop',
      browser: 'Chrome',
      lang: 'fi-FI',
      is_bot: false,
    });
    expect((await sql()`SELECT session_count FROM share_links WHERE id = ${l.id}`)[0]!.session_count).toBe(1);
    // no external origins anywhere in the page
    expect(r.body).not.toMatch(/(src|href)="https?:\/\/(?!video\.test)/);
  });

  it('returns an identical 404 for unknown, expired, closed and deleted links', async () => {
    const expired = await createLink({
      label: 'expired',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const closed = await createLink({ label: 'closed', isActive: false });
    const deleted = await createLink({ label: 'deleted' });
    await t.app.inject({ method: 'DELETE', url: `/api/admin/links/${deleted.id}`, headers: authed(owner) });
    const bodies = new Set<string>();
    const times: number[] = [];
    for (const slug of ['doesnotexist1', expired.slug, closed.slug, deleted.slug, '..%2Fadmin', 'x']) {
      const started = performance.now();
      const r = await view(slug);
      times.push(performance.now() - started);
      expect(r.statusCode).toBe(404);
      bodies.add(r.body);
    }
    expect(bodies.size).toBe(1);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(145);
    const ev = await sql()`SELECT type FROM link_events WHERE link_id = ${expired.id}`;
    expect(ev.map((e) => e.type)).toContain('link_expired_hit');
  });

  it('records link-preview bots without creating sessions or consuming max_sessions', async () => {
    const l = await createLink({ label: 'bots', maxSessions: 1 });
    for (const ua of [
      'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
      'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    ]) {
      const r = await view(l.slug, { 'user-agent': ua });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('og:image');
      expect(r.body).not.toContain('vs-config');
    }
    const previews =
      await sql()`SELECT bot_name FROM link_previews WHERE link_id = ${l.id} ORDER BY fetched_at`;
    expect(previews.map((p) => p.bot_name)).toEqual(['LinkedInBot', 'Slackbot']);
    expect((await view(l.slug)).statusCode).toBe(200);
    expect((await view(l.slug)).statusCode).toBe(404); // max_sessions = 1 reached by a human
  });

  it('protects links with a password (argon2id, 5 attempts / 15 min / IP)', async () => {
    const l = await createLink({ label: 'pw', password: 'salainen' });
    const page = await view(l.slug);
    expect(page.body).toContain('name="password"');
    expect(page.body).not.toContain('vs-config');
    const wrong = await t.app.inject({
      method: 'POST',
      url: `/v/${l.slug}/unlock`,
      payload: 'password=nope',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(wrong.statusCode).toBe(401);
    const ok = await t.app.inject({
      method: 'POST',
      url: `/v/${l.slug}/unlock`,
      payload: 'password=salainen',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(ok.statusCode).toBe(303);
    const cookie = String(ok.headers['set-cookie']).split(';')[0]!;
    const unlocked = await view(l.slug, { cookie });
    expect(unlocked.body).toContain('vs-config');
    for (let i = 0; i < 4; i++) {
      await t.app.inject({
        method: 'POST',
        url: `/v/${l.slug}/unlock`,
        payload: 'password=nope',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
    }
    const limited = await t.app.inject({
      method: 'POST',
      url: `/v/${l.slug}/unlock`,
      payload: 'password=salainen',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(limited.statusCode).toBe(429);
  });

  it('redirects CTA clicks through /go and records them', async () => {
    const l = await createLink({ label: 'cta' });
    const page = await view(l.slug);
    const href = /<a class="vs-cta" data-cta="cv" href="([^"]+)"/.exec(page.body)![1]!;
    const go = await t.app.inject({ url: href });
    expect(go.statusCode).toBe(302);
    expect(go.headers.location).toBe('https://example.com/cv.pdf');
    const sessionId = href.split('/')[2]!;
    const s = await sql()`SELECT cta_clicks FROM session_summaries WHERE session_id = ${sessionId}`;
    expect(s[0]!.cta_clicks).toBe(1);
    const forged = await t.app.inject({ url: href.replace(/\/[^/]+$/, '/AAAAAAAAAAAAAAAAAAAAAA') });
    expect(forged.statusCode).toBe(404);
  });

  it('changes slugs with an optional 301 from the old slug', async () => {
    const l = await createLink({ label: 'rename' });
    const old = l.slug;
    const r = await t.app.inject({
      method: 'PATCH',
      url: `/api/admin/links/${l.id}`,
      headers: authed(owner),
      payload: { slug: 'new-name-k3x9q7', keepOldSlugRedirect: true },
    });
    expect(r.statusCode, r.body).toBe(200);
    const redirect = await view(old);
    expect(redirect.statusCode).toBe(301);
    expect(redirect.headers.location).toBe('/v/new-name-k3x9q7');
  });

  it('bulk-creates links from CSV and refreshes playback tokens', async () => {
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/admin/videos/${videoId}/links/bulk`,
      headers: authed(owner),
      payload: {
        csv: 'label,recipient_name,recipient_org\n"Yritys A, HR",Anna,Yritys A\nYritys B,Bert,Yritys B\n',
      },
    });
    expect(r.json().created.map((c: { label: string }) => c.label)).toEqual(['Yritys A, HR', 'Yritys B']);
    const slug = r.json().created[0].slug;
    const page = await view(slug);
    const cfg = JSON.parse(/id="vs-config">(.*?)<\/script>/s.exec(page.body)![1]!);
    const refresh = await t.app.inject({ url: cfg.playbackUrl, headers: { 'x-vs-token': cfg.token } });
    expect(refresh.json().master).toContain(`/${cfg.sessionId}/`);
    expect(
      (await t.app.inject({ url: cfg.playbackUrl, headers: { 'x-vs-token': 'bogus.token' } })).statusCode,
    ).toBe(404);
  });

  it('allows embedding only when allow_embed is set', async () => {
    const no = await createLink({ label: 'noembed' });
    expect((await t.app.inject({ url: `/e/${no.slug}`, headers: { 'user-agent': CHROME } })).statusCode).toBe(
      404,
    );
    const yes = await createLink({ label: 'embed', allowEmbed: true });
    const r = await t.app.inject({ url: `/e/${yes.slug}`, headers: { 'user-agent': CHROME } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-security-policy']).toContain('frame-ancestors *');
  });

  it('viewer cannot create links; privacy page renders', async () => {
    const viewer = await loginViewer(t.app, owner);
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/admin/videos/${videoId}/links`,
      headers: authed(viewer),
      payload: { label: 'x' },
    });
    expect(r.statusCode).toBe(403);
    const p = await t.app.inject({ url: '/privacy', headers: { 'accept-language': 'en' } });
    expect(p.body).toContain('Privacy notice');
  });
});
