import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  audit,
  sha256Hex,
  newId,
  hitRateLimit,
  encryptJson,
  decryptJson,
  QUEUES,
  type NotifyJob,
} from '@vs/core';
import { bootstrapSchema, idParams, loginSchema, reauthSchema, totpSchema } from '@vs/shared';
import type { AppContext } from '../../context.js';
import { hashPassword, verifyPassword, dummyVerify } from '../../lib/password.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../../lib/totp.js';
import { badRequest, HttpError, unauthorized, tooMany, conflict, notFound } from '../../lib/errors.js';
import { adminCookieOptions, createAdminSession, SESSION_COOKIE } from '../../plugins/auth.js';

const LOCK_AFTER = 10;
const LOCK_MINUTES = 15;

export async function authRoutes(fastify: FastifyInstance, ctx: AppContext) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const sql = ctx.database.sql;
  const key = ctx.config.APP_ENCRYPTION_KEY;
  const idleMinutes = ctx.config.ADMIN_SESSION_IDLE_MINUTES;

  /**
   * Alerts the notification channels when a user signs in from an address with no successful sign-in
   * in the last 90 days. Must run before the current sign-in is audited.
   */
  const alertIfNewAddress = async (req: FastifyRequest, userId: string) => {
    const seen = await sql`
      SELECT 1 FROM audit_log WHERE actor_user_id = ${userId} AND action = 'auth.login'
        AND ip IS NOT DISTINCT FROM ${req.clientIp}::inet AND created_at > now() - interval '90 days' LIMIT 1`;
    if (seen.length) return;
    await ctx.jobs.send(QUEUES.notify, {
      kind: 'admin_login',
      userId,
      ip: req.clientIp,
      userAgent: (req.headers['user-agent'] ?? '').slice(0, 200),
    } satisfies NotifyJob);
  };

  app.get('/auth/state', { config: { public: true } }, async () => {
    const r = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM admin_users WHERE deleted_at IS NULL`;
    return { bootstrapRequired: (r[0]?.n ?? 0) === 0, oidc: !!ctx.config.OIDC_ISSUER };
  });

  app.post(
    '/auth/bootstrap',
    { config: { public: true }, schema: { body: bootstrapSchema } },
    async (req, reply) => {
      const rl = await hitRateLimit(sql, `bootstrap:${req.clientIp}`, 10, 900);
      if (rl.limited) throw tooMany();
      const { token, email, password } = req.body;
      const userId = newId();
      const ok = await sql.begin(async (tx) => {
        await tx`LOCK TABLE admin_users IN EXCLUSIVE MODE`;
        const n = await tx<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM admin_users WHERE deleted_at IS NULL`;
        if ((n[0]?.n ?? 0) > 0) return 'exists' as const;
        const del = await tx`DELETE FROM bootstrap_tokens WHERE token_hash = ${sha256Hex(token)} RETURNING 1`;
        if (!del.length) return 'bad_token' as const;
        await tx`INSERT INTO admin_users (id, email, password_hash, role) VALUES (${userId}, ${email}, ${await hashPassword(password)}, 'owner')`;
        await tx`DELETE FROM bootstrap_tokens`;
        return 'ok' as const;
      });
      if (ok === 'exists') throw conflict('already bootstrapped');
      if (ok === 'bad_token') throw unauthorized('invalid bootstrap token');
      await audit(sql, {
        actorUserId: userId,
        action: 'auth.bootstrap',
        entity: 'admin_user',
        entityId: userId,
        ip: req.clientIp,
      });
      const { csrfToken } = await createAdminSession(ctx, reply, req, userId, 'full');
      return { stage: 'enroll_required', csrfToken };
    },
  );

  app.post('/auth/login', { config: { public: true }, schema: { body: loginSchema } }, async (req, reply) => {
    const ipLimit = await hitRateLimit(sql, `login-ip:${req.clientIp}`, ctx.config.LOGIN_RATE_LIMIT, 900);
    if (ipLimit.limited) throw tooMany('too many login attempts');
    const { email, password } = req.body;
    const rows = await sql<
      {
        id: string;
        password_hash: string;
        totp_secret: string | null;
        role: string;
        failed_logins: number;
        locked_until: Date | null;
        disabled: boolean;
      }[]
    >`SELECT id, password_hash, totp_secret, role, failed_logins, locked_until, disabled
      FROM admin_users WHERE lower(email) = lower(${email}) AND deleted_at IS NULL`;
    const user = rows[0];
    const fail = async (reason: string) => {
      await audit(sql, {
        actorUserId: user?.id ?? null,
        actorLabel: email,
        action: 'auth.login_failed',
        diff: { reason },
        ip: req.clientIp,
      });
      return new HttpError(401, 'invalid_credentials', 'invalid email or password');
    };
    if (!user || user.disabled) {
      await dummyVerify(password);
      throw await fail(user ? 'disabled' : 'unknown_user');
    }
    if (user.locked_until && user.locked_until > new Date()) {
      await dummyVerify(password);
      await audit(sql, { actorUserId: user.id, action: 'auth.login_locked', ip: req.clientIp });
      throw new HttpError(423, 'account_locked', 'account temporarily locked');
    }
    if (!(await verifyPassword(user.password_hash, password))) {
      const failed = user.failed_logins + 1;
      await sql`UPDATE admin_users SET failed_logins = ${failed >= LOCK_AFTER ? 0 : failed},
                locked_until = ${failed >= LOCK_AFTER ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null}
                WHERE id = ${user.id}`;
      if (failed >= LOCK_AFTER) {
        await ctx.jobs.send(QUEUES.notify, {
          kind: 'admin_lockout',
          userId: user.id,
          ip: req.clientIp,
        } satisfies NotifyJob);
      }
      throw await fail('bad_password');
    }
    await sql`UPDATE admin_users SET failed_logins = 0, locked_until = NULL WHERE id = ${user.id}`;
    const stage = user.totp_secret ? 'pending_totp' : 'full';
    const { csrfToken } = await createAdminSession(ctx, reply, req, user.id, stage);
    if (stage === 'full') {
      await sql`UPDATE admin_users SET last_login_at = now() WHERE id = ${user.id}`;
      await alertIfNewAddress(req, user.id);
      await audit(sql, { actorUserId: user.id, action: 'auth.login', ip: req.clientIp });
    }
    return { stage: stage === 'full' && user.role !== 'viewer' ? 'enroll_required' : stage, csrfToken };
  });

  app.post(
    '/auth/totp',
    { config: { allowStages: ['pending_totp'] }, schema: { body: totpSchema } },
    async (req) => {
      const p = req.admin!;
      const rl = await hitRateLimit(sql, `totp:${p.userId}`, 5, 300);
      if (rl.limited) throw tooMany('too many attempts');
      const rows = await sql<{ totp_secret: string; totp_last_step: number | null }[]>`
        SELECT totp_secret, totp_last_step FROM admin_users WHERE id = ${p.userId}`;
      const u = rows[0];
      if (!u?.totp_secret) throw badRequest('totp not enabled');
      const step = verifyTotp(decryptJson<string>(key, u.totp_secret), req.body.code, u.totp_last_step);
      if (step === null) {
        await audit(sql, { actorUserId: p.userId, action: 'auth.totp_failed', ip: req.clientIp });
        throw new HttpError(401, 'invalid_code', 'invalid code');
      }
      await sql`UPDATE admin_users SET totp_last_step = ${step}, last_login_at = now() WHERE id = ${p.userId}`;
      await sql`UPDATE admin_sessions SET stage = 'full', reauth_at = now(),
                  expires_at = least(now() + make_interval(mins => ${idleMinutes}), absolute_expires_at)
                WHERE id = ${p.sessionId}`;
      await alertIfNewAddress(req, p.userId!);
      await audit(sql, {
        actorUserId: p.userId,
        action: 'auth.login',
        diff: { totp: true },
        ip: req.clientIp,
      });
      return { stage: 'full' };
    },
  );

  app.post('/auth/totp/enroll', { config: { allowStages: ['enroll_required'] } }, async (req) => {
    const p = req.admin!;
    const secret = generateTotpSecret();
    await sql`UPDATE admin_users SET totp_pending_secret = ${encryptJson(key, secret)} WHERE id = ${p.userId}`;
    return { secret, otpauthUrl: otpauthUrl(secret, p.email, 'video-share') };
  });

  app.post(
    '/auth/totp/enroll/confirm',
    { config: { allowStages: ['enroll_required'] }, schema: { body: totpSchema } },
    async (req) => {
      const p = req.admin!;
      const rows = await sql<{ totp_pending_secret: string | null }[]>`
        SELECT totp_pending_secret FROM admin_users WHERE id = ${p.userId}`;
      const pending = rows[0]?.totp_pending_secret;
      if (!pending) throw badRequest('no pending enrollment');
      const step = verifyTotp(decryptJson<string>(key, pending), req.body.code, null);
      if (step === null) throw new HttpError(400, 'invalid_code', 'invalid code');
      await sql`UPDATE admin_users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, totp_last_step = ${step}
                WHERE id = ${p.userId}`;
      await audit(sql, {
        actorUserId: p.userId,
        action: 'auth.totp_enrolled',
        entity: 'admin_user',
        entityId: p.userId,
        ip: req.clientIp,
      });
      return { stage: 'full' };
    },
  );

  app.post(
    '/auth/logout',
    { config: { allowStages: ['pending_totp', 'enroll_required'] } },
    async (req, reply) => {
      const p = req.admin!;
      if (p.sessionId) await sql`DELETE FROM admin_sessions WHERE id = ${p.sessionId}`;
      reply.clearCookie(SESSION_COOKIE, adminCookieOptions(ctx, req));
      await audit(sql, { actorUserId: p.userId, action: 'auth.logout', ip: req.clientIp });
      return { ok: true };
    },
  );

  app.get(
    '/me',
    { config: { allowStages: ['pending_totp', 'enroll_required'], allowApiToken: true } },
    async (req) => {
      const p = req.admin!;
      return {
        id: p.userId,
        email: p.email,
        role: p.role,
        stage: p.stage,
        totpEnabled: p.totpEnabled,
        totpRequired: p.role !== 'viewer',
        csrfToken: p.csrfToken,
      };
    },
  );

  app.post('/auth/reauth', { schema: { body: reauthSchema } }, async (req, reply) => {
    const p = req.admin!;
    const rl = await hitRateLimit(sql, `reauth:${p.userId}`, 5, 300);
    if (rl.limited) {
      // Someone holding this session keeps guessing: end the session instead of waiting it out.
      await sql`DELETE FROM admin_sessions WHERE id = ${p.sessionId}`;
      reply.clearCookie(SESSION_COOKIE, adminCookieOptions(ctx, req));
      await audit(sql, { actorUserId: p.userId, action: 'auth.reauth_locked', ip: req.clientIp });
      throw tooMany('too many attempts; signed out');
    }
    const rows = await sql<
      { password_hash: string; totp_secret: string | null; totp_last_step: number | null }[]
    >`
      SELECT password_hash, totp_secret, totp_last_step FROM admin_users WHERE id = ${p.userId}`;
    const u = rows[0];
    const failed = async (reason: string) => {
      await audit(sql, {
        actorUserId: p.userId,
        action: 'auth.reauth_failed',
        diff: { reason },
        ip: req.clientIp,
      });
      return new HttpError(401, 'invalid_credentials', 'password or code is wrong');
    };
    if (!u || !(await verifyPassword(u.password_hash, req.body.password))) throw await failed('bad_password');
    let step: number | null = null;
    if (u.totp_secret) {
      if (!req.body.code) throw await failed('missing_code');
      step = verifyTotp(decryptJson<string>(key, u.totp_secret), req.body.code, u.totp_last_step);
      if (step === null) throw await failed('bad_code');
      await sql`UPDATE admin_users SET totp_last_step = ${step} WHERE id = ${p.userId}`;
    }
    await sql`UPDATE admin_sessions SET reauth_at = now() WHERE id = ${p.sessionId}`;
    await audit(sql, { actorUserId: p.userId, action: 'auth.reauth', ip: req.clientIp });
    return { ok: true, totp: step !== null };
  });

  // ---- own sessions (sign out other devices)
  app.get('/me/sessions', async (req) => {
    const p = req.admin!;
    return sql`
      SELECT id, host(ip) AS ip, user_agent AS "userAgent", created_at AS "createdAt", last_seen_at AS "lastSeenAt",
             expires_at AS "expiresAt", (id = ${p.sessionId}) AS current
      FROM admin_sessions WHERE user_id = ${p.userId} AND expires_at > now() AND absolute_expires_at > now()
      ORDER BY last_seen_at DESC`;
  });

  app.delete('/me/sessions/:id', { schema: { params: idParams } }, async (req) => {
    const p = req.admin!;
    const del =
      await sql`DELETE FROM admin_sessions WHERE id = ${req.params.id} AND user_id = ${p.userId} RETURNING id`;
    if (!del.length) throw notFound();
    await audit(sql, {
      actorUserId: p.userId,
      action: 'auth.session_revoked',
      entity: 'admin_session',
      entityId: req.params.id,
      ip: req.clientIp,
    });
    return { ok: true };
  });

  app.post('/me/sessions/revoke-others', async (req) => {
    const p = req.admin!;
    const del =
      await sql`DELETE FROM admin_sessions WHERE user_id = ${p.userId} AND id <> ${p.sessionId} RETURNING id`;
    await audit(sql, {
      actorUserId: p.userId,
      action: 'auth.sessions_revoked',
      diff: { count: del.length },
      ip: req.clientIp,
    });
    return { revoked: del.length };
  });

  app.post(
    '/me/password',
    {
      schema: { body: z.object({ current: z.string().min(1).max(256), next: z.string().min(12).max(256) }) },
    },
    async (req) => {
      const p = req.admin!;
      const rows = await sql<
        { password_hash: string }[]
      >`SELECT password_hash FROM admin_users WHERE id = ${p.userId}`;
      if (!rows[0] || !(await verifyPassword(rows[0].password_hash, req.body.current))) {
        throw new HttpError(400, 'invalid_password', 'current password is wrong');
      }
      await sql`UPDATE admin_users SET password_hash = ${await hashPassword(req.body.next)} WHERE id = ${p.userId}`;
      await sql`DELETE FROM admin_sessions WHERE user_id = ${p.userId} AND id <> ${p.sessionId}`;
      await audit(sql, {
        actorUserId: p.userId,
        action: 'auth.password_changed',
        entity: 'admin_user',
        entityId: p.userId,
        ip: req.clientIp,
      });
      return { ok: true };
    },
  );
}
