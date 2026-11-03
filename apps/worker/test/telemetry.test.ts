import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { SMTPServer } from 'smtp-server';
import { pino } from 'pino';
import { encryptJson, newId, putSettings } from '@vs/core';
import { makeApp, bootstrapOwner, authed, type TestApp, type Session } from '../../api/test/support.js';
import { enrichIp } from '../src/ipintel/enrich.js';
import { classifyNetwork, ptrDomain } from '../src/ipintel/classify.js';
import { rangeToCidr } from '../src/ipintel/rdap.js';
import { matchVisitor } from '../src/telemetry/visitors.js';
import { notifyOpen } from '../src/telemetry/notify.js';
import { parseSyslogLine, storeMediaLines } from '../src/telemetry/syslog.js';
import { closeIdleSessions } from '../src/telemetry/sessions.js';

const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const log = pino({ level: 'silent' });

describe('telemetry', () => {
  let t: TestApp;
  let owner: Session;
  let videoId: string;
  const sql = () => t.ctx.database.sql;

  const openPage = async (slug: string, ip = '198.51.100.7') => {
    const r = await t.app.inject({
      url: `/v/${slug}`,
      headers: { 'user-agent': CHROME, 'x-forwarded-for': ip },
      remoteAddress: '127.0.0.1',
    });
    expect(r.statusCode).toBe(200);
    return JSON.parse(/id="vs-config">(.*?)<\/script>/s.exec(r.body)![1]!) as {
      sessionId: string;
      token: string;
      master: string;
    };
  };
  const link = async (body: Record<string, unknown> = {}) =>
    (
      await t.app.inject({
        method: 'POST',
        url: `/api/admin/videos/${videoId}/links`,
        headers: authed(owner),
        payload: { label: 'L', ...body },
      })
    ).json();
  const send = (token: string, events: unknown[], url = '/t/v1/events') =>
    t.app.inject({ method: 'POST', url, payload: { token, events } });
  let seq = 0;
  const ev = (type: string, payload: Record<string, unknown> = {}, position_ms = 0) => ({
    seq: seq++,
    type,
    client_ts: Date.now(),
    position_ms,
    payload,
  });

  beforeAll(async () => {
    t = await makeApp();
    owner = await bootstrapOwner(t.app, t.ctx);
    const [v] = await sql()<{ id: string }[]>`
      INSERT INTO videos (id, title, status, hls_version, duration_ms, width, height) VALUES (gen_random_uuid(), 'T', 'ready', 1, 30000, 1280, 720) RETURNING id`;
    videoId = v!.id;
  });
  afterAll(() => t.close());

  it('ingests a JS session: 0–30 %, seek to 60 %, play to 70 %, close', async () => {
    const l = await link();
    const cfg = await openPage(l.slug);
    seq = 0;
    const r1 = await send(cfg.token, [
      ev('page_view', {
        viewport: { w: 1280, h: 720 },
        screen: { w: 1920, h: 1080 },
        tz: 'Europe/Helsinki',
        lang: 'fi-FI',
        unknownField: 'dropped',
      }),
      ev('player_ready', { startup_ms: 300, renditions: [720, 480, 360] }),
      ev('play', { source: 'user' }),
      ev('first_frame', { ttff_ms: 200 }),
      ev('heartbeat', { played_delta: [[0, 5000]], rendition: 720 }, 5000),
      ev('heartbeat', { played_delta: [[5000, 9000]], rendition: 720 }, 9000),
      ev('quartile', { q: 25 }, 9000),
      ev('seek', { from_ms: 9000, to_ms: 18000 }, 18000),
    ]);
    expect(r1.json()).toMatchObject({ accepted: 8, duplicates: 0, rejected: 0 });
    // replayed batch → deduplicated; beacon with text/plain
    const dup = await send(cfg.token, [
      {
        seq: 4,
        type: 'heartbeat',
        client_ts: Date.now(),
        position_ms: 5000,
        payload: { played_delta: [[0, 5000]] },
      },
    ]);
    expect(dup.json()).toMatchObject({ accepted: 0, duplicates: 1 });
    const beacon = await t.app.inject({
      method: 'POST',
      url: '/t/v1/beacon',
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify({
        token: cfg.token,
        events: [
          ev('heartbeat', { played_delta: [[18000, 21000]] }, 21000),
          ev('session_end', { exit_reason: 'closed' }, 21000),
          { seq: 99, type: 'bogus' },
        ],
      }),
    });
    expect(beacon.json()).toMatchObject({ accepted: 2, rejected: 1 });
    const s = (await sql()`SELECT * FROM session_summaries WHERE session_id = ${cfg.sessionId}`)[0]!;
    expect(s.source).toBe('client');
    expect(Math.abs(Number(s.unique_watched_ms) - 12_000)).toBeLessThanOrEqual(1000);
    expect(s.quartiles).toEqual([25]);
    expect(s.seek_count).toBe(1);
    expect(s.startup_ms).toBe(300);
    expect(s.exit_reason).toBe('closed');
    const vs = (await sql()`SELECT * FROM view_sessions WHERE id = ${cfg.sessionId}`)[0]!;
    expect(vs).toMatchObject({
      has_client_telemetry: true,
      screen_w: 1920,
      tz: 'Europe/Helsinki',
      is_bot: false,
    });
    const stored =
      await sql()`SELECT payload FROM events WHERE session_id = ${cfg.sessionId} AND type = 'page_view'`;
    expect(stored[0]!.payload).not.toHaveProperty('unknownField');
  });

  it('rejects bad tokens and never writes to another session', async () => {
    expect((await send('x'.repeat(40), [ev('play')])).statusCode).toBe(401);
    const a = await openPage((await link()).slug);
    // token for session A only ever writes to session A
    await send(a.token, [ev('play', { source: 'user' })]);
    const n =
      await sql()`SELECT count(*)::int AS n FROM events WHERE session_id <> ${a.sessionId} AND seq = ${seq - 1}`;
    expect(n[0]!.n).toBe(0);
  });

  it('flags headless browsers (navigator.webdriver) as bots', async () => {
    const cfg = await openPage((await link()).slug);
    await send(cfg.token, [ev('page_view', { webdriver: true, screen: { w: 1920, h: 1080 } })]);
    expect(
      (await sql()`SELECT is_bot, bot_name FROM view_sessions WHERE id = ${cfg.sessionId}`)[0],
    ).toMatchObject({ is_bot: true, bot_name: 'headless' });
  });

  it('ignores client telemetry when the level is "server"', async () => {
    await putSettings(sql(), { telemetry: { level: 'server' } });
    const cfg = await openPage((await link()).slug);
    expect((await send(cfg.token, [ev('play', { source: 'user' })])).statusCode).toBe(204);
    await putSettings(sql(), { telemetry: { level: 'full' } });
  });

  it('estimates watching from nginx segment logs when JS is blocked', async () => {
    const cfg = await openPage((await link()).slug);
    const t0 = Date.now() - 60_000;
    // hls.js-like fetch pattern for 0–15 s of a 30 s video (4 s segments, 10 s buffer)
    const pattern: [number, number][] = [
      [0, 0],
      [0, 1],
      [0, 2],
      [2000, 3],
      [6000, 4],
      [10000, 5],
      [14000, 6],
    ];
    const lines = pattern.map(([dt, i]) =>
      parseSyslogLine(
        `<190>Nov  3 12:00:00 vsmedia: ${JSON.stringify({ ts: new Date(t0 + dt).toISOString(), sess: cfg.sessionId, vid: videoId, ver: '1', file: `720p_${String(i).padStart(5, '0')}.m4s`, status: 200, bytes: 100000, rt: 0.01, proto: 'HTTP/1.1', tls: '' })}`,
      )!,
    );
    expect(parseSyslogLine('<190>garbage')).toBeNull();
    expect(await storeMediaLines(sql(), lines)).toBe(7);
    const s = (
      await sql()`SELECT source, unique_watched_ms, server_unique_watched_ms FROM session_summaries WHERE session_id = ${cfg.sessionId}`
    )[0]!;
    expect(s.source).toBe('server');
    expect(Math.abs(Number(s.unique_watched_ms) - 15_000)).toBeLessThanOrEqual(8_000);
    // idle → closed with a session_timeout event
    await sql()`UPDATE view_sessions SET last_seen_at = now() - interval '31 minutes' WHERE id = ${cfg.sessionId}`;
    expect(await closeIdleSessions(sql())).toContain(cfg.sessionId);
    expect(
      (await sql()`SELECT type FROM events WHERE session_id = ${cfg.sessionId}`).map((e) => e.type),
    ).toContain('session_timeout');
  });

  it('classifies LAN addresses without any external lookup', async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      throw new Error('no network');
    }) as unknown as typeof fetch;
    const resolver = {
      reverse: async () => (calls++, []),
      resolve4: async () => [],
      resolve6: async () => [],
    };
    const id = await enrichIp({ sql: sql(), config: t.ctx.config, log, fetcher, resolver }, '10.20.30.40');
    expect(calls).toBe(0);
    const row = (await sql()`SELECT network_type, confidence FROM ip_intel WHERE id = ${id}`)[0]!;
    expect(row).toMatchObject({ network_type: 'lan', confidence: 'high' });
  });

  it('enriches a public IP with RDAP and confirmed PTR (mocked) and caches by allocation', async () => {
    const calls: string[] = [];
    const fetcher = (async (url: string) => {
      calls.push(url);
      const body = url.includes('ipv4.json')
        ? { services: [[['203.0.113.0/24'], ['https://rdap.example.net/']]] }
        : url.includes('ipv6.json')
          ? { services: [] }
          : {
              name: 'ACME-NET',
              handle: 'ACME-1',
              country: 'FI',
              cidr0_cidrs: [{ v4prefix: '203.0.113.0', length: 24 }],
              entities: [
                {
                  roles: ['registrant'],
                  handle: 'ORG-ACME1',
                  vcardArray: [
                    'vcard',
                    [
                      ['fn', {}, 'text', 'Acme Oy'],
                      ['org', {}, 'text', 'Acme Oy'],
                    ],
                  ],
                },
                { roles: ['abuse'], vcardArray: ['vcard', [['email', {}, 'text', 'abuse@acme.example']]] },
              ],
            };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const resolver = {
      reverse: async () => ['gw1.acme.example'],
      resolve4: async () => ['203.0.113.10'],
      resolve6: async () => [],
    };
    const cfg = await openPage((await link()).slug, '203.0.113.10');
    const id = await enrichIp({ sql: sql(), config: t.ctx.config, log, fetcher, resolver }, '203.0.113.10');
    const row = (await sql()`SELECT * FROM ip_intel WHERE id = ${id}`)[0]!;
    expect(row).toMatchObject({
      rdap_org: 'Acme Oy',
      rdap_cidr: '203.0.113.0/24',
      abuse_email: 'abuse@acme.example',
      ptr: 'gw1.acme.example',
      ptr_confirmed: true,
      network_type: 'corporate',
      confidence: 'high',
    });
    expect(
      (await sql()`SELECT ip_intel_id FROM view_sessions WHERE id = ${cfg.sessionId}`)[0]!.ip_intel_id,
    ).toBe(id);
    const before = calls.filter((c) => c.includes('/ip/')).length;
    await enrichIp({ sql: sql(), config: t.ctx.config, log, fetcher, resolver }, '203.0.113.99');
    expect(calls.filter((c) => c.includes('/ip/')).length).toBe(before); // same allocation → no new RDAP query
  });

  it('heuristics', () => {
    expect(ptrDomain('a-1-2.dyn.elisa-laajakaista.fi')).toBe('elisa-laajakaista.fi');
    expect(ptrDomain('host.example.co.uk')).toBe('example.co.uk');
    expect(rangeToCidr('192.0.2.0', '192.0.2.255')).toBe('192.0.2.0/24');
    expect(
      classifyNetwork({
        asn: 16509,
        asOrg: 'AMAZON-02',
        ptr: null,
        ptrConfirmed: null,
        rdapOrg: null,
        rdapNetname: null,
        city: null,
        isTor: false,
      }).networkType,
    ).toBe('hosting_cloud');
    expect(
      classifyNetwork({
        asn: 53813,
        asOrg: 'ZSCALER',
        ptr: null,
        ptrConfirmed: null,
        rdapOrg: null,
        rdapNetname: null,
        city: null,
        isTor: false,
      }).networkType,
    ).toBe('security_proxy');
    expect(
      classifyNetwork({
        asn: 719,
        asOrg: 'Elisa Oyj',
        ptr: 'dsl-hkibng1-1.dhcp.inet.fi',
        ptrConfirmed: true,
        rdapOrg: 'Elisa Oyj',
        rdapNetname: 'ELISA',
        city: 'Helsinki',
        isTor: false,
      }),
    ).toMatchObject({ networkType: 'residential_isp', confidence: 'low', orgGuess: 'Elisa Oyj, Helsinki' });
    expect(
      classifyNetwork({
        asn: 1759,
        asOrg: 'Telia Finland Oyj',
        ptr: 'mobile-1-2-3.lte.telia.fi',
        ptrConfirmed: true,
        rdapOrg: null,
        rdapNetname: null,
        city: null,
        isTor: false,
      }).networkType,
    ).toBe('mobile');
    expect(
      classifyNetwork({
        asn: 1741,
        asOrg: 'FUNET',
        ptr: 'x.helsinki.fi',
        ptrConfirmed: true,
        rdapOrg: 'University of Helsinki',
        rdapNetname: null,
        city: null,
        isTor: false,
      }).networkType,
    ).toBe('edu');
  });

  it('links the same browser on two links to the same visitor', async () => {
    const signals = {
      ua: CHROME,
      platform: 'MacIntel',
      languages: ['fi-FI'],
      hc: 8,
      tz: 'Europe/Helsinki',
      canvas: 'c1',
      audio: '1.23',
      fonts: ['Arial'],
      webglRenderer: 'Apple M1',
      viewport: [1280, 720],
    };
    const a = await openPage((await link()).slug, '192.0.2.10');
    const b = await openPage((await link()).slug, '192.0.2.10');
    seq = 0;
    await send(a.token, [ev('fingerprint', { signals, randomized: false })]);
    const fa = (await sql()`SELECT fingerprint_id FROM view_sessions WHERE id = ${a.sessionId}`)[0]!
      .fingerprint_id as string;
    const ma = await matchVisitor(sql(), a.sessionId, fa);
    seq = 0;
    await send(b.token, [
      ev('fingerprint', { signals: { ...signals, viewport: [800, 600] }, randomized: false }),
    ]);
    const vb = (
      await sql()`SELECT visitor_id, visitor_confidence FROM view_sessions WHERE id = ${b.sessionId}`
    )[0]!;
    expect(vb).toEqual({ visitor_id: ma!.visitorId, visitor_confidence: 'exact' }); // matched at ingest via fp_hash
    // a slightly different profile on the same /24 → probable
    const c = await openPage((await link()).slug, '192.0.2.11');
    seq = 0;
    await sql()`UPDATE view_sessions SET asn = NULL`;
    await send(c.token, [ev('fingerprint', { signals: { ...signals, hc: 10 }, randomized: false })]);
    const fc = (await sql()`SELECT fingerprint_id FROM view_sessions WHERE id = ${c.sessionId}`)[0]!
      .fingerprint_id as string;
    expect(await matchVisitor(sql(), c.sessionId, fc)).toEqual({
      visitorId: ma!.visitorId,
      confidence: 'probable',
    });
    const v = (await sql()`SELECT session_count, link_count FROM visitors WHERE id = ${ma!.visitorId}`)[0]!;
    expect(v.link_count).toBeGreaterThanOrEqual(2);
  });

  it('sends ntfy and email notifications exactly once on the first human play', async () => {
    const ntfy: { path: string; title: string; body: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        ntfy.push({ path: req.url ?? '', title: String(req.headers.title ?? ''), body });
        res.end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const ntfyPort = (server.address() as { port: number }).port;
    const mails: string[] = [];
    const smtp = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      onData(stream, _s, cb) {
        let d = '';
        stream.on('data', (c) => (d += c));
        stream.on('end', () => {
          mails.push(d);
          cb();
        });
      },
    });
    await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
    const smtpPort = (smtp.server.address() as { port: number }).port;
    try {
      const key = t.ctx.config.APP_ENCRYPTION_KEY;
      await sql()`INSERT INTO notification_channels (id, kind, config) VALUES
        (${newId()}, 'ntfy', ${encryptJson(key, { url: `http://127.0.0.1:${ntfyPort}`, topic: 'video' })}),
        (${newId()}, 'email', ${encryptJson(key, { to: 'me@example.com' })})`;
      const nodemailer = await import('nodemailer');
      const mailer = nodemailer.default.createTransport({
        host: '127.0.0.1',
        port: smtpPort,
        secure: false,
        ignoreTLS: true,
      });
      const deps = { sql: sql(), config: t.ctx.config, log, mailer, enrichWaitMs: 0 };
      const l = await link({ label: 'Yritys X', notifyOnOpen: true });
      const a = await openPage(l.slug, '10.1.1.1');
      seq = 0;
      await send(a.token, [ev('play', { source: 'user' })]);
      expect(await notifyOpen(deps, a.sessionId)).toBe(true);
      expect(await notifyOpen(deps, a.sessionId)).toBe(false); // same session again
      const b = await openPage(l.slug, '10.1.1.2');
      seq = 0;
      await send(b.token, [ev('play', { source: 'user' })]);
      expect(await notifyOpen(deps, b.sessionId)).toBe(false); // first open already notified
      expect(ntfy).toHaveLength(1);
      expect(ntfy[0]!.path).toBe('/video');
      expect(ntfy[0]!.body).toContain("Linkki 'Yritys X' avattiin");
      expect(mails).toHaveLength(1);
      expect(mails[0]).toContain('me@example.com');
      const sent = (await t.ctx.jobs) as unknown as { sent: { queue: string }[] };
      expect(sent.sent.some((j) => j.queue === 'notify')).toBe(true);
    } finally {
      server.close();
      smtp.close();
    }
  });
});
