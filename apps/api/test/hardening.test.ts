import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt, currentStep } from '../src/lib/totp.js';
import { authed, bootstrapOwner, cookieOf, makeApp, type Session, type TestApp } from './support.js';

/** Admin hardening for internet-facing (VPS) installs, see docs/VPS.md and D36. */
describe('admin hardening', () => {
  let t: TestApp;
  let owner: Session & { secret: string; email: string; password: string };
  const sql = () => t.ctx.database.sql;
  const jobs = () =>
    (t.ctx.jobs as unknown as { sent: { queue: string; data: Record<string, unknown> }[] }).sent;
  const expireReauth = () => sql()`UPDATE admin_sessions SET reauth_at = now() - interval '1 hour'`;
  const nextCode = async () => {
    await sql()`UPDATE admin_users SET totp_last_step = ${currentStep() - 2} WHERE email = ${owner.email}`;
    return totpAt(owner.secret, currentStep());
  };

  beforeAll(async () => {
    t = await makeApp();
    owner = await bootstrapOwner(t.app, t.ctx);
  });
  afterAll(() => t.close());

  it('requires a fresh password + TOTP check for sensitive owner actions', async () => {
    const create = (email: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/admin/users',
        headers: authed(owner),
        payload: { email, password: 'some password 123', role: 'viewer' },
      });
    // a fresh sign-in counts as a recent check
    expect((await create('fresh@example.com')).statusCode).toBe(200);

    await expireReauth();
    const blocked = await create('later@example.com');
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json().error.code).toBe('reauth_required');
    for (const [method, url] of [
      ['POST', '/api/admin/api-tokens'],
      ['PUT', '/api/admin/settings'],
      ['POST', '/api/admin/notification-channels'],
      ['POST', '/api/admin/gdpr/delete'],
      ['GET', '/api/admin/gdpr/export?ip=192.0.2.1'],
    ] as const) {
      const r = await t.app.inject({
        method,
        url,
        headers: authed(owner),
        payload: method === 'GET' ? undefined : {},
      });
      expect([url, r.statusCode, r.json().error?.code]).toEqual([url, 401, 'reauth_required']);
    }
    // ordinary editing is not affected
    expect((await t.app.inject({ url: '/api/admin/videos', headers: authed(owner) })).statusCode).toBe(200);

    const reauth = (payload: object) =>
      t.app.inject({ method: 'POST', url: '/api/admin/auth/reauth', headers: authed(owner), payload });
    expect((await reauth({ password: 'wrong password' })).statusCode).toBe(401);
    expect((await reauth({ password: owner.password })).statusCode).toBe(401); // TOTP code missing
    expect((await reauth({ password: owner.password, code: '000000' })).statusCode).toBe(401);
    const ok = await reauth({ password: owner.password, code: await nextCode() });
    expect(ok.statusCode).toBe(200);
    expect((await create('later@example.com')).statusCode).toBe(200);

    const actions = await sql()<{ action: string }[]>`
      SELECT action FROM audit_log WHERE action LIKE 'auth.reauth%' ORDER BY created_at`;
    expect(actions.map((a) => a.action)).toEqual([
      'auth.reauth_failed',
      'auth.reauth_failed',
      'auth.reauth_failed',
      'auth.reauth',
    ]);
  });

  it('ends the session after too many wrong re-authentication attempts', async () => {
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/admin/auth/login',
      payload: { email: owner.email, password: owner.password },
    });
    const s = { cookie: cookieOf(login), csrf: login.json().csrfToken as string };
    await t.app.inject({
      method: 'POST',
      url: '/api/admin/auth/totp',
      headers: authed(s),
      payload: { code: await nextCode() },
    });
    await sql()`DELETE FROM rate_limits WHERE key LIKE 'reauth:%'`;
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await t.app.inject({
        method: 'POST',
        url: '/api/admin/auth/reauth',
        headers: authed(s),
        payload: { password: 'guess number ' + i },
      });
      codes.push(r.statusCode);
    }
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
    expect((await t.app.inject({ url: '/api/admin/me', headers: authed(s) })).statusCode).toBe(401);
  });

  it('lists own sessions and signs out other devices', async () => {
    const other = await t.app.inject({
      method: 'POST',
      url: '/api/admin/auth/login',
      payload: { email: owner.email, password: owner.password },
      headers: { 'user-agent': 'OtherBrowser/1.0' },
    });
    const otherCookie = cookieOf(other);
    const list = await t.app.inject({ url: '/api/admin/me/sessions', headers: authed(owner) });
    expect(list.statusCode).toBe(200);
    const rows = list.json() as { id: string; current: boolean; userAgent: string }[];
    expect(rows.filter((r) => r.current)).toHaveLength(1);
    expect(rows.some((r) => r.userAgent === 'OtherBrowser/1.0')).toBe(true);

    const revoked = await t.app.inject({
      method: 'POST',
      url: '/api/admin/me/sessions/revoke-others',
      headers: authed(owner),
    });
    expect(revoked.json().revoked).toBeGreaterThanOrEqual(1);
    expect((await t.app.inject({ url: '/api/admin/me', headers: { cookie: otherCookie } })).statusCode).toBe(
      401,
    );
    expect((await t.app.inject({ url: '/api/admin/me', headers: authed(owner) })).statusCode).toBe(200);
    // cannot revoke someone else's session id
    const foreign = await t.app.inject({
      method: 'DELETE',
      url: '/api/admin/me/sessions/00000000-0000-7000-8000-000000000000',
      headers: authed(owner),
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('alerts on sign-in from a new address and on lockout', async () => {
    const before = jobs().length;
    const signIn = async (ip: string) => {
      const l = await t.app.inject({
        method: 'POST',
        url: '/api/admin/auth/login',
        payload: { email: owner.email, password: owner.password },
        remoteAddress: ip,
      });
      await t.app.inject({
        method: 'POST',
        url: '/api/admin/auth/totp',
        headers: { cookie: cookieOf(l), 'x-csrf-token': l.json().csrfToken },
        payload: { code: await nextCode() },
        remoteAddress: ip,
      });
    };
    await signIn('192.168.50.7');
    await signIn('192.168.50.7');
    const alerts = jobs()
      .slice(before)
      .filter((j) => j.data.kind === 'admin_login');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.data.ip).toBe('192.168.50.7');

    for (let i = 0; i < 10; i++) {
      await t.app.inject({
        method: 'POST',
        url: '/api/admin/auth/login',
        payload: { email: owner.email, password: 'wrong' },
        remoteAddress: `10.20.0.${i}`,
      });
    }
    expect(jobs().some((j) => j.data.kind === 'admin_lockout')).toBe(true);
    await sql()`UPDATE admin_users SET locked_until = NULL, failed_logins = 0`;
  });
});

describe('ADMIN_LISTENER=private', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp({ ADMIN_LISTENER: 'private', PUBLIC_SCHEME: 'https', ADMIN_ALLOW_CIDRS: '0.0.0.0/0' });
  });
  /** Requests as nginx forwards them from the private admin listener. */
  const viaAdminListener = (app: TestApp['app']) => {
    const inject = app.inject.bind(app);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test shim over inject's overloads
    (app as any).inject = (o: any) => inject({ ...o, headers: { 'x-vs-listener': 'admin', ...o.headers } });
  };
  afterAll(() => t.close());

  it('serves admin only through the private nginx listener', async () => {
    const pub = await t.app.inject({ url: '/api/admin/auth/state', headers: { 'x-vs-listener': 'public' } });
    expect(pub.statusCode).toBe(404);
    const none = await t.app.inject({ url: '/api/admin/auth/state' });
    expect(none.statusCode).toBe(404);
    // the header only counts from a trusted proxy (nginx); a direct client cannot claim it
    const spoof = await t.app.inject({
      url: '/api/admin/auth/state',
      headers: { 'x-vs-listener': 'admin' },
      remoteAddress: '203.0.113.9',
    });
    expect(spoof.statusCode).toBe(404);
    const priv = await t.app.inject({ url: '/api/admin/auth/state', headers: { 'x-vs-listener': 'admin' } });
    expect(priv.statusCode).toBe(200);
    // public pages are unaffected
    expect((await t.app.inject({ url: '/healthz' })).statusCode).toBe(200);
  });

  it('uses a non-Secure cookie only on the private listener over plain HTTP', async () => {
    viaAdminListener(t.app);
    const owner = await bootstrapOwner(t.app, t.ctx);
    const login = (headers: Record<string, string>) =>
      t.app.inject({
        method: 'POST',
        url: '/api/admin/auth/login',
        payload: { email: owner.email, password: owner.password },
        headers: { 'x-vs-listener': 'admin', ...headers },
      });
    const plain = String((await login({ 'x-forwarded-proto': 'http' })).headers['set-cookie']);
    expect(plain).not.toMatch(/Secure/);
    expect(plain).toMatch(/HttpOnly/);
    expect(plain).toMatch(/SameSite=Strict/);
    const tls = String((await login({ 'x-forwarded-proto': 'https' })).headers['set-cookie']);
    expect(tls).toMatch(/Secure/);
  });

  it('reports insecure configurations on the System page', async () => {
    const open = await makeApp({ PUBLIC_SCHEME: 'https', ADMIN_ALLOW_CIDRS: '0.0.0.0/0' });
    try {
      const owner = await bootstrapOwner(open.app, open.ctx);
      const sys = await open.app.inject({ url: '/api/admin/system', headers: authed(owner) });
      expect(sys.json().security.warnings).toContain('admin_open_to_internet');
    } finally {
      await open.close();
    }
  });
});
