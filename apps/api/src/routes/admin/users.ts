import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit, newId, randomToken, sha256Hex } from '@vs/core';
import { userCreateSchema, userPatchSchema, apiTokenCreateSchema, idParams, pageQuery } from '@vs/shared';
import type { AppContext } from '../../context.js';
import { requireRole } from '../../plugins/auth.js';
import { hashPassword } from '../../lib/password.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { offset, orderBy } from '../../lib/paging.js';

export async function userRoutes(fastify: FastifyInstance, ctx: AppContext) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const sql = ctx.database.sql;
  const owner = { preValidation: requireRole('owner') };

  app.get('/users', owner, async () => {
    return sql`SELECT id, email, role, disabled, (totp_secret IS NOT NULL) AS "totpEnabled", last_login_at AS "lastLoginAt",
                      created_at AS "createdAt"
               FROM admin_users WHERE deleted_at IS NULL ORDER BY created_at`;
  });

  app.post('/users', { ...owner, schema: { body: userCreateSchema } }, async (req) => {
    const { email, password, role } = req.body;
    const exists =
      await sql`SELECT 1 FROM admin_users WHERE lower(email) = lower(${email}) AND deleted_at IS NULL`;
    if (exists.length) throw conflict('email already in use');
    const id = newId();
    await sql`INSERT INTO admin_users (id, email, password_hash, role) VALUES (${id}, ${email}, ${await hashPassword(password)}, ${role})`;
    await audit(sql, {
      actorUserId: req.admin!.userId,
      action: 'user.create',
      entity: 'admin_user',
      entityId: id,
      diff: { email, role },
      ip: req.clientIp,
    });
    return { id };
  });

  app.patch('/users/:id', { ...owner, schema: { params: idParams, body: userPatchSchema } }, async (req) => {
    const { id } = req.params;
    const rows = await sql<
      { role: string; disabled: boolean }[]
    >`SELECT role, disabled FROM admin_users WHERE id = ${id} AND deleted_at IS NULL`;
    const before = rows[0];
    if (!before) throw notFound('user');
    const b = req.body;
    if (id === req.admin!.userId && ((b.role && b.role !== 'owner') || b.disabled))
      throw badRequest('cannot demote or disable yourself');
    if (b.role) await sql`UPDATE admin_users SET role = ${b.role} WHERE id = ${id}`;
    if (b.disabled !== undefined) {
      await sql`UPDATE admin_users SET disabled = ${b.disabled} WHERE id = ${id}`;
      if (b.disabled) await sql`DELETE FROM admin_sessions WHERE user_id = ${id}`;
    }
    if (b.password) {
      await sql`UPDATE admin_users SET password_hash = ${await hashPassword(b.password)} WHERE id = ${id}`;
      await sql`DELETE FROM admin_sessions WHERE user_id = ${id}`;
    }
    await audit(sql, {
      actorUserId: req.admin!.userId,
      action: 'user.update',
      entity: 'admin_user',
      entityId: id,
      diff: { role: b.role, disabled: b.disabled, password: b.password ? '***' : undefined },
      ip: req.clientIp,
    });
    return { ok: true };
  });

  app.post('/users/:id/reset-totp', { ...owner, schema: { params: idParams } }, async (req) => {
    await sql`UPDATE admin_users SET totp_secret = NULL, totp_pending_secret = NULL, totp_last_step = NULL WHERE id = ${req.params.id}`;
    await sql`DELETE FROM admin_sessions WHERE user_id = ${req.params.id}`;
    await audit(sql, {
      actorUserId: req.admin!.userId,
      action: 'user.reset_totp',
      entity: 'admin_user',
      entityId: req.params.id,
      ip: req.clientIp,
    });
    return { ok: true };
  });

  app.delete('/users/:id', { ...owner, schema: { params: idParams } }, async (req) => {
    if (req.params.id === req.admin!.userId) throw badRequest('cannot delete yourself');
    const r =
      await sql`UPDATE admin_users SET deleted_at = now(), disabled = true WHERE id = ${req.params.id} AND deleted_at IS NULL RETURNING id`;
    if (!r.length) throw notFound('user');
    await sql`DELETE FROM admin_sessions WHERE user_id = ${req.params.id}`;
    await audit(sql, {
      actorUserId: req.admin!.userId,
      action: 'user.delete',
      entity: 'admin_user',
      entityId: req.params.id,
      ip: req.clientIp,
    });
    return { ok: true };
  });

  // ---- API tokens (read-only analytics access)
  app.get('/api-tokens', owner, async () => {
    return sql`SELECT id, name, created_at AS "createdAt", last_used_at AS "lastUsedAt", revoked_at AS "revokedAt"
               FROM api_tokens ORDER BY created_at DESC`;
  });
  app.post('/api-tokens', { ...owner, schema: { body: apiTokenCreateSchema } }, async (req) => {
    const id = newId();
    const token = `vst_${randomToken(32)}`;
    await sql`INSERT INTO api_tokens (id, name, token_hash, created_by) VALUES (${id}, ${req.body.name}, ${sha256Hex(token)}, ${req.admin!.userId})`;
    await audit(sql, {
      actorUserId: req.admin!.userId,
      action: 'api_token.create',
      entity: 'api_token',
      entityId: id,
      diff: { name: req.body.name },
      ip: req.clientIp,
    });
    return { id, token };
  });
  app.delete('/api-tokens/:id', { ...owner, schema: { params: idParams } }, async (req) => {
    await sql`UPDATE api_tokens SET revoked_at = now() WHERE id = ${req.params.id} AND revoked_at IS NULL`;
    await audit(sql, {
      actorUserId: req.admin!.userId,
      action: 'api_token.revoke',
      entity: 'api_token',
      entityId: req.params.id,
      ip: req.clientIp,
    });
    return { ok: true };
  });

  // ---- audit log
  app.get(
    '/audit-log',
    {
      preValidation: requireRole('editor'),
      schema: {
        querystring: pageQuery.extend({
          action: z.string().max(64).optional(),
          actor: z.string().uuid().optional(),
          entityId: z.string().max(64).optional(),
        }),
      },
    },
    async (req) => {
      const q = req.query;
      const { dir } = orderBy(q, { createdAt: 'a.created_at' }, 'createdAt');
      const where = sql`WHERE true
        ${q.action ? sql`AND a.action LIKE ${q.action + '%'}` : sql``}
        ${q.actor ? sql`AND a.actor_user_id = ${q.actor}` : sql``}
        ${q.entityId ? sql`AND a.entity_id = ${q.entityId}` : sql``}
        ${q.q ? sql`AND (a.action ILIKE ${'%' + q.q + '%'} OR a.actor_label ILIKE ${'%' + q.q + '%'} OR u.email ILIKE ${'%' + q.q + '%'})` : sql``}`;
      const items = await sql`
        SELECT a.id, a.action, a.entity, a.entity_id AS "entityId", a.diff, host(a.ip) AS ip, a.created_at AS "createdAt",
               coalesce(u.email, a.actor_label) AS actor
        FROM audit_log a LEFT JOIN admin_users u ON u.id = a.actor_user_id
        ${where}
        ORDER BY a.created_at ${dir === 'ASC' ? sql`ASC` : sql`DESC`}
        LIMIT ${q.pageSize} OFFSET ${offset(q)}`;
      const total = await sql<
        { n: number }[]
      >`SELECT count(*)::int AS n FROM audit_log a LEFT JOIN admin_users u ON u.id = a.actor_user_id ${where}`;
      return { items, total: total[0]?.n ?? 0, page: q.page, pageSize: q.pageSize };
    },
  );
}
