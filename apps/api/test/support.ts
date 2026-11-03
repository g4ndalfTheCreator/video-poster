import { pino } from 'pino';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { ensureBootstrapToken } from '../src/lib/bootstrap.js';
import { totpAt, currentStep } from '../src/lib/totp.js';
import { createTestDatabase, testConfig } from '../../../test/helpers.js';
import type { AppContext } from '../src/context.js';
import type { Config } from '@vs/core';

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  close: () => Promise<void>;
}

export async function makeApp(
  configOverrides: Record<string, string> = {},
  extra: Partial<AppContext> = {},
): Promise<TestApp> {
  const t = await createTestDatabase();
  const config: Config = testConfig(configOverrides);
  const ctx: AppContext = {
    config,
    database: t.database,
    boss: null,
    log: pino({ level: process.env.TEST_LOG_LEVEL ?? 'silent' }),
    ...extra,
  };
  const app = await buildApp(ctx);
  return {
    app,
    ctx,
    close: async () => {
      await app.close();
      await t.drop();
    },
  };
}

export function cookieOf(res: LightMyRequestResponse): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = list.find((x) => x.startsWith('vs_admin='));
  if (!c) throw new Error('no session cookie');
  return c.split(';')[0]!;
}

export interface Session {
  cookie: string;
  csrf: string;
  secret?: string;
}

/** Bootstraps an owner with TOTP enrolled; returns a fully authenticated session. */
export async function bootstrapOwner(
  app: FastifyInstance,
  ctx: AppContext,
  email = 'owner@example.com',
  password = 'correct horse battery',
): Promise<Session & { secret: string; email: string; password: string }> {
  const token = await ensureBootstrapToken(ctx.database.sql);
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/auth/bootstrap',
    payload: { token, email, password },
  });
  if (res.statusCode !== 200) throw new Error(`bootstrap failed: ${res.body}`);
  const cookie = cookieOf(res);
  const csrf = res.json().csrfToken as string;
  const enroll = await app.inject({
    method: 'POST',
    url: '/api/admin/auth/totp/enroll',
    headers: { cookie, 'x-csrf-token': csrf },
  });
  const secret = enroll.json().secret as string;
  const confirm = await app.inject({
    method: 'POST',
    url: '/api/admin/auth/totp/enroll/confirm',
    headers: { cookie, 'x-csrf-token': csrf },
    payload: { code: totpAt(secret, currentStep()) },
  });
  if (confirm.statusCode !== 200) throw new Error(`enroll failed: ${confirm.body}`);
  return { cookie, csrf, secret, email, password };
}

export function authed(s: Session) {
  return { cookie: s.cookie, 'x-csrf-token': s.csrf };
}

export async function loginViewer(
  app: FastifyInstance,
  owner: Session,
  email = 'viewer@example.com',
): Promise<Session> {
  const password = 'viewer password 123';
  const r = await app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: authed(owner),
    payload: { email, password, role: 'viewer' },
  });
  if (r.statusCode !== 200) throw new Error(r.body);
  const login = await app.inject({
    method: 'POST',
    url: '/api/admin/auth/login',
    payload: { email, password },
  });
  return { cookie: cookieOf(login), csrf: login.json().csrfToken };
}
