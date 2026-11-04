import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ipInCidrs, sha256Hex, randomToken, safeEqual, newId } from '@vs/core';
import type { Role } from '@vs/shared';
import type { AppContext } from '../context.js';
import { forbidden, notFound, unauthorized, HttpError } from '../lib/errors.js';

export const SESSION_COOKIE = 'vs_admin';
const ABSOLUTE_MS = 7 * 24 * 3600 * 1000;
const idleMs = (ctx: AppContext) => ctx.config.ADMIN_SESSION_IDLE_MINUTES * 60_000;

export type AuthStage = 'pending_totp' | 'enroll_required' | 'full';

export interface AdminPrincipal {
  kind: 'user' | 'token';
  userId: string | null;
  tokenId: string | null;
  email: string;
  role: Role;
  sessionId: string | null;
  csrfToken: string | null;
  totpEnabled: boolean;
  stage: AuthStage;
  /** Last password (+ TOTP) check in this session; null for API tokens. */
  reauthAt: Date | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    admin: AdminPrincipal | null;
  }
  interface FastifyContextConfig {
    /** No authentication required (login, bootstrap). */
    public?: boolean;
    /** Additional auth stages allowed besides 'full'. */
    allowStages?: AuthStage[];
    /** API tokens (read-only) may call this GET route. */
    allowApiToken?: boolean;
  }
}

const ROLE_LEVEL: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_LEVEL[role] >= ROLE_LEVEL[min];
}

/** preValidation factory: requires a role of at least `min`. */
export function requireRole(min: Role) {
  return async (req: FastifyRequest) => {
    if (!req.admin) throw unauthorized();
    if (!roleAtLeast(req.admin.role, min)) throw forbidden(`requires role ${min}`);
  };
}

/**
 * Sensitive actions (users, API tokens, notification channels, settings, GDPR erase) need a password
 * (+ TOTP) check within ADMIN_REAUTH_MINUTES, so a stolen session cookie alone cannot take over the
 * installation. The admin UI asks for the password and retries on `reauth_required`.
 */
export function requireRecentAuth(ctx: AppContext) {
  return async (req: FastifyRequest) => {
    const p = req.admin;
    if (!p) throw unauthorized();
    const fresh = p.reauthAt && Date.now() - p.reauthAt.getTime() < ctx.config.ADMIN_REAUTH_MINUTES * 60_000;
    if (!fresh) throw new HttpError(401, 'reauth_required', 'confirm your password to continue');
  };
}

/**
 * Which nginx listener received the request. nginx always overwrites X-VS-Listener; the header is
 * only believed from a trusted proxy, so a client reaching the api some other way cannot claim it.
 */
export function listenerOf(ctx: AppContext, req: FastifyRequest): 'admin' | 'public' {
  return req.headers['x-vs-listener'] === 'admin' &&
    ipInCidrs(req.socket.remoteAddress, ctx.config.TRUSTED_PROXIES)
    ? 'admin'
    : 'public';
}

/**
 * Secure cookies follow PUBLIC_SCHEME, except on the private admin listener over plain HTTP (SSH tunnel
 * or VPN to 127.0.0.1:8081), where a Secure cookie would not be stored by every browser.
 */
export function adminCookieOptions(ctx: AppContext, req: FastifyRequest) {
  const plainPrivate = listenerOf(ctx, req) === 'admin' && req.headers['x-forwarded-proto'] === 'http';
  return {
    httpOnly: true,
    secure: ctx.config.cookieSecure && !plainPrivate,
    sameSite: 'strict' as const,
    path: '/',
  };
}

export function isAdminNetworkAllowed(ctx: AppContext, req: FastifyRequest): boolean {
  // ADMIN_LISTENER=private: only requests that nginx received on the private admin listener.
  if (ctx.config.ADMIN_LISTENER === 'private' && listenerOf(ctx, req) !== 'admin') return false;
  if (ctx.config.ADMIN_HOST) {
    const host = (req.headers.host ?? '').split(':')[0];
    if (host !== ctx.config.ADMIN_HOST.split(':')[0]) return false;
  }
  return ipInCidrs(req.clientIp, ctx.config.ADMIN_ALLOW_CIDRS);
}

export async function createAdminSession(
  ctx: AppContext,
  reply: FastifyReply,
  req: FastifyRequest,
  userId: string,
  stage: 'pending_totp' | 'full',
): Promise<{ csrfToken: string }> {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const now = Date.now();
  await ctx.database.sql`
    INSERT INTO admin_sessions (id, user_id, token_hash, csrf_token, stage, ip, user_agent, expires_at, absolute_expires_at, reauth_at)
    VALUES (${newId()}, ${userId}, ${sha256Hex(token)}, ${csrfToken}, ${stage}, ${req.clientIp},
            ${(req.headers['user-agent'] ?? '').slice(0, 500)},
            ${new Date(now + (stage === 'full' ? idleMs(ctx) : 10 * 60 * 1000))}, ${new Date(now + ABSOLUTE_MS)},
            ${stage === 'full' ? new Date(now) : null})`;
  reply.setCookie(SESSION_COOKIE, token, { ...adminCookieOptions(ctx, req), maxAge: ABSOLUTE_MS / 1000 });
  return { csrfToken };
}

async function loadPrincipal(ctx: AppContext, req: FastifyRequest): Promise<AdminPrincipal | null> {
  const sql = ctx.database.sql;
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const rows = await sql<{ id: string; name: string }[]>`
      UPDATE api_tokens SET last_used_at = now()
      WHERE token_hash = ${sha256Hex(auth.slice(7).trim())} AND revoked_at IS NULL
      RETURNING id, name`;
    const t = rows[0];
    if (!t) return null;
    return {
      kind: 'token',
      userId: null,
      tokenId: t.id,
      email: `token:${t.name}`,
      role: 'viewer',
      sessionId: null,
      csrfToken: null,
      totpEnabled: false,
      stage: 'full',
      reauthAt: null,
    };
  }
  const cookie = req.cookies[SESSION_COOKIE];
  if (!cookie) return null;
  const rows = await sql<
    {
      session_id: string;
      csrf_token: string;
      stage: 'pending_totp' | 'full';
      last_seen_at: Date;
      absolute_expires_at: Date;
      reauth_at: Date | null;
      user_id: string;
      email: string;
      role: Role;
      totp_secret: string | null;
    }[]
  >`
    SELECT s.id AS session_id, s.csrf_token, s.stage, s.last_seen_at, s.absolute_expires_at, s.reauth_at,
           u.id AS user_id, u.email, u.role, u.totp_secret
    FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id
    WHERE s.token_hash = ${sha256Hex(cookie)} AND s.expires_at > now() AND s.absolute_expires_at > now()
      AND u.deleted_at IS NULL AND NOT u.disabled`;
  const s = rows[0];
  if (!s) return null;
  if (s.stage === 'full' && Date.now() - s.last_seen_at.getTime() > 60_000) {
    const expires = new Date(Math.min(Date.now() + idleMs(ctx), s.absolute_expires_at.getTime()));
    await sql`UPDATE admin_sessions SET last_seen_at = now(), expires_at = ${expires} WHERE id = ${s.session_id}`;
  }
  const totpEnabled = !!s.totp_secret;
  let stage: AuthStage = s.stage;
  // TOTP is mandatory for roles with write access.
  if (stage === 'full' && !totpEnabled && s.role !== 'viewer') stage = 'enroll_required';
  return {
    kind: 'user',
    userId: s.user_id,
    tokenId: null,
    email: s.email,
    role: s.role,
    sessionId: s.session_id,
    csrfToken: s.csrf_token,
    totpEnabled,
    stage,
    reauthAt: s.reauth_at,
  };
}

/**
 * Registers network restriction, principal loading, stage enforcement and CSRF checks on an
 * encapsulated admin scope.
 */
export function registerAdminGuards(app: FastifyInstance, ctx: AppContext): void {
  app.decorateRequest('admin', null);
  app.addHook('onRequest', async (req) => {
    if (!isAdminNetworkAllowed(ctx, req)) throw notFound();
  });
  // preValidation: authorization must happen before body validation (no information leak, 403 not 400).
  app.addHook('preValidation', async (req) => {
    const cfg = req.routeOptions.config ?? {};
    req.admin = await loadPrincipal(ctx, req);
    if (cfg.public) return;
    const p = req.admin;
    if (!p) throw unauthorized();
    if (p.kind === 'token') {
      if (!cfg.allowApiToken || (req.method !== 'GET' && req.method !== 'HEAD'))
        throw forbidden('api tokens are read-only');
      return;
    }
    if (p.stage !== 'full' && !(cfg.allowStages ?? []).includes(p.stage)) {
      throw new HttpError(
        401,
        p.stage === 'pending_totp' ? 'totp_required' : 'totp_enroll_required',
        'second factor required',
      );
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const header = req.headers['x-csrf-token'];
      if (typeof header !== 'string' || !p.csrfToken || !safeEqual(header, p.csrfToken)) {
        throw forbidden('invalid csrf token');
      }
    }
  });
}
