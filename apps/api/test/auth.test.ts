import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeApp, bootstrapOwner, cookieOf, authed, loginViewer, type TestApp } from './support.js';
import { ensureBootstrapToken } from '../src/lib/bootstrap.js';
import { totpAt, currentStep } from '../src/lib/totp.js';

describe('admin auth', () => {
  let t: TestApp;
  let owner: Awaited<ReturnType<typeof bootstrapOwner>>;
  beforeAll(async () => {
    t = await makeApp();
  });
  afterAll(() => t.close());

  it('reports bootstrap state and rejects a wrong bootstrap token', async () => {
    const st = await t.app.inject({ url: '/api/admin/auth/state' });
    expect(st.json()).toEqual({ bootstrapRequired: true, oidc: false });
    await ensureBootstrapToken(t.ctx.database.sql);
    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/admin/auth/bootstrap',
      payload: { token: 'x'.repeat(32), email: 'a@b.fi', password: 'long enough password' },
    });
    expect(bad.statusCode).toBe(401);
  });

  it('bootstraps an owner who must enroll TOTP before doing anything', async () => {
    const token = await ensureBootstrapToken(t.ctx.database.sql);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/admin/auth/bootstrap',
      payload: { token, email: 'first@example.com', password: 'correct horse battery' },
    });
    expect(res.json(), res.body).toMatchObject({ stage: 'enroll_required' });
    const cookie = cookieOf(res);
    const users = await t.app.inject({ url: '/api/admin/users', headers: { cookie } });
    expect(users.statusCode).toBe(401);
    expect(users.json().error.code).toBe('totp_enroll_required');
    // second bootstrap is impossible
    const again = await t.app.inject({
      method: 'POST',
      url: '/api/admin/auth/bootstrap',
      payload: { token: token ?? 'x'.repeat(32), email: 'x@example.com', password: 'correct horse battery' },
    });
    expect(again.statusCode).toBeGreaterThanOrEqual(401);
    expect(await ensureBootstrapToken(t.ctx.database.sql)).toBeNull();
    await t.ctx.database.sql`DELETE FROM admin_users`;
  });

  it('full login flow with TOTP, CSRF and replay protection', async () => {
    owner = await bootstrapOwner(t.app, t.ctx);
    const me = await t.app.inject({ url: '/api/admin/me', headers: { cookie: owner.cookie } });
    expect(me.json()).toMatchObject({ role: 'owner', stage: 'full', totpEnabled: true });

    // CSRF required on mutations
    const noCsrf = await t.app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: { cookie: owner.cookie },
      payload: {},
    });
    expect(noCsrf.statusCode).toBe(403);

    const login = await t.app.inject({
      method: 'POST',
      url: '/api/admin/auth/login',
      payload: { email: owner.email, password: owner.password },
    });
    expect(login.json().stage).toBe('pending_totp');
    const cookie = cookieOf(login);
    const csrf = login.json().csrfToken;
    const blocked = await t.app.inject({ url: '/api/admin/users', headers: { cookie } });
    expect(blocked.json().error.code).toBe('totp_required');

    // the code used at enrollment cannot be replayed
    const replay = await t.app.inject({
      method: 'POST',
      url: '/api/admin/auth/totp',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { code: totpAt(owner.secret, currentStep()) },
    });
    expect(replay.statusCode).toBe(401);
    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/admin/auth/totp',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { code: totpAt(owner.secret, currentStep() + 1) },
    });
    expect(ok.statusCode).toBe(200);
    const users = await t.app.inject({ url: '/api/admin/users', headers: { cookie } });
    expect(users.statusCode).toBe(200);

    const logout = await t.app.inject({
      method: 'POST',
      url: '/api/admin/auth/logout',
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect(logout.statusCode).toBe(200);
    expect((await t.app.inject({ url: '/api/admin/me', headers: { cookie } })).statusCode).toBe(401);

    const actions = await t.ctx.database.sql<
      { action: string }[]
    >`SELECT action FROM audit_log ORDER BY created_at`;
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'auth.bootstrap',
        'auth.totp_enrolled',
        'auth.login',
        'auth.totp_failed',
        'auth.logout',
      ]),
    );
  });

  it('viewer gets 403 from every mutating admin route', async () => {
    const viewer = await loginViewer(t.app, owner);
    const me = await t.app.inject({ url: '/api/admin/me', headers: { cookie: viewer.cookie } });
    expect(me.json()).toMatchObject({ role: 'viewer', stage: 'full' });

    const skip = /\/auth\/|\/me\/password$/;
    const mutating = t.app.routeList.filter(
      (r) =>
        r.url.startsWith('/api/admin') && !['GET', 'HEAD', 'OPTIONS'].includes(r.method) && !skip.test(r.url),
    );
    expect(mutating.length).toBeGreaterThan(5);
    for (const r of mutating) {
      const url = r.url.replace(/:[a-zA-Z]+/g, '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b');
      const res = await t.app.inject({
        method: r.method as 'POST',
        url,
        headers: authed(viewer),
        payload: {},
      });
      expect.soft(res.statusCode, `${r.method} ${r.url}`).toBe(403);
    }
  });

  it('locks the account after 10 failed logins', async () => {
    await t.app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: authed(owner),
      payload: { email: 'lock@example.com', password: 'lock password 123', role: 'viewer' },
    });
    for (let i = 0; i < 10; i++) {
      const r = await t.app.inject({
        method: 'POST',
        url: '/api/admin/auth/login',
        payload: { email: 'lock@example.com', password: 'wrong' },
        remoteAddress: `10.9.0.${i}`,
      });
      expect(r.statusCode).toBe(401);
    }
    const locked = await t.app.inject({
      method: 'POST',
      url: '/api/admin/auth/login',
      payload: { email: 'lock@example.com', password: 'lock password 123' },
    });
    expect(locked.statusCode).toBe(423);
  });

  it('blocks admin routes from outside ADMIN_ALLOW_CIDRS', async () => {
    const outside = await t.app.inject({ url: '/api/admin/auth/state', remoteAddress: '203.0.113.5' });
    expect(outside.statusCode).toBe(404);
    const inside = await t.app.inject({ url: '/api/admin/auth/state', remoteAddress: '192.168.1.10' });
    expect(inside.statusCode).toBe(200);
    // spoofed X-Forwarded-For from an untrusted peer is ignored
    const spoof = await t.app.inject({
      url: '/api/admin/auth/state',
      remoteAddress: '203.0.113.5',
      headers: { 'x-forwarded-for': '192.168.1.10' },
    });
    expect(spoof.statusCode).toBe(404);
    // ...but honoured from a trusted proxy
    const viaProxy = await t.app.inject({
      url: '/api/admin/auth/state',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.5' },
    });
    expect(viaProxy.statusCode).toBe(404);
  });

  it('api tokens are read-only', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/admin/api-tokens',
      headers: authed(owner),
      payload: { name: 'grafana' },
    });
    const token = created.json().token as string;
    const me = await t.app.inject({ url: '/api/admin/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    const users = await t.app.inject({
      url: '/api/admin/users',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(users.statusCode).toBe(403);
    const write = await t.app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(write.statusCode).toBe(403);
  });
});
