import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit, decryptJson, encryptJson, newId, parseCidr, QUEUES, type NotifyJob } from '@vs/core';
import { channelCreateSchema, idParams, ipOverrideSchema } from '@vs/shared';
import type { AppContext } from '../../context.js';
import { requireRecentAuth, requireRole } from '../../plugins/auth.js';
import { badRequest, notFound } from '../../lib/errors.js';

const SECRET_KEYS = new Set(['token', 'secret']);
const mask = (c: Record<string, string>) =>
  Object.fromEntries(Object.entries(c).map(([k, v]) => [k, SECRET_KEYS.has(k) && v ? '••••' : v]));

export async function channelRoutes(fastify: FastifyInstance, ctx: AppContext) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const sql = ctx.database.sql;
  const key = ctx.config.APP_ENCRYPTION_KEY;
  const owner = { preValidation: requireRole('owner') };
  /** Owner + a recent password (+ TOTP) check, see requireRecentAuth. */
  const sensitive = { preValidation: [requireRole('owner'), requireRecentAuth(ctx)] };

  app.get('/notification-channels', owner, async () => {
    const rows = await sql<
      { id: string; kind: string; config: string; is_active: boolean; created_at: Date }[]
    >`
      SELECT id, kind, config, is_active, created_at FROM notification_channels ORDER BY created_at`;
    const last = await sql<{ channel_id: string; ok: boolean; error: string | null; sent_at: Date }[]>`
      SELECT DISTINCT ON (channel_id) channel_id, ok, error, sent_at FROM notifications_log WHERE channel_id IS NOT NULL ORDER BY channel_id, sent_at DESC`;
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      isActive: r.is_active,
      createdAt: r.created_at,
      config: mask(decryptJson<Record<string, string>>(key, r.config)),
      lastDelivery: last.find((l) => l.channel_id === r.id) ?? null,
    }));
  });

  app.post('/notification-channels', { ...sensitive, schema: { body: channelCreateSchema } }, async (req) => {
    const id = newId();
    await sql`INSERT INTO notification_channels (id, kind, config, is_active) VALUES (${id}, ${req.body.kind}, ${encryptJson(key, req.body.config)}, ${req.body.isActive})`;
    await audit(sql, {
      actorUserId: req.admin!.userId,
      action: 'channel.create',
      entity: 'notification_channel',
      entityId: id,
      diff: { kind: req.body.kind },
      ip: req.clientIp,
    });
    return { id };
  });

  app.patch(
    '/notification-channels/:id',
    { ...sensitive, schema: { params: idParams, body: z.object({ isActive: z.boolean() }) } },
    async (req) => {
      const r =
        await sql`UPDATE notification_channels SET is_active = ${req.body.isActive} WHERE id = ${req.params.id} RETURNING id`;
      if (!r.length) throw notFound('channel');
      await audit(sql, {
        actorUserId: req.admin!.userId,
        action: 'channel.update',
        entity: 'notification_channel',
        entityId: req.params.id,
        diff: req.body,
        ip: req.clientIp,
      });
      return { ok: true };
    },
  );

  app.delete('/notification-channels/:id', { ...sensitive, schema: { params: idParams } }, async (req) => {
    const r = await sql`DELETE FROM notification_channels WHERE id = ${req.params.id} RETURNING id`;
    if (!r.length) throw notFound('channel');
    await audit(sql, {
      actorUserId: req.admin!.userId,
      action: 'channel.delete',
      entity: 'notification_channel',
      entityId: req.params.id,
      ip: req.clientIp,
    });
    return { ok: true };
  });

  app.post('/notification-channels/:id/test', { ...owner, schema: { params: idParams } }, async (req) => {
    const r = await sql`SELECT 1 FROM notification_channels WHERE id = ${req.params.id}`;
    if (!r.length) throw notFound('channel');
    await ctx.jobs.send(QUEUES.notify, { kind: 'test', channelId: req.params.id } satisfies NotifyJob);
    return { ok: true };
  });

  // ---- manual organisation labels for IPs / prefixes (win over automatic guesses)
  const editor = { preValidation: requireRole('editor') };
  app.get('/ip-overrides', editor, async () => {
    return sql`SELECT o.id, o.cidr::text AS cidr, o.org_label AS "orgLabel", o.note, o.created_at AS "createdAt", u.email AS "createdBy"
               FROM ip_org_overrides o LEFT JOIN admin_users u ON u.id = o.created_by ORDER BY o.created_at DESC`;
  });
  app.post('/ip-overrides', { ...editor, schema: { body: ipOverrideSchema } }, async (req) => {
    const parsed = parseCidr(req.body.cidr);
    if (!parsed) throw badRequest('invalid IP or CIDR');
    const cidr = `${parsed[0].toString()}/${parsed[1]}`;
    const id = newId();
    await sql`INSERT INTO ip_org_overrides (id, cidr, org_label, note, created_by) VALUES (${id}, ${cidr}::cidr, ${req.body.orgLabel}, ${req.body.note ?? null}, ${req.admin!.userId})`.catch(
      () => {
        throw badRequest('CIDR has host bits set; use the network address');
      },
    );
    // Apply to existing intel rows so past sessions show the label too.
    await sql`UPDATE ip_intel SET org_guess = ${req.body.orgLabel}, confidence = 'high' WHERE ip <<= ${cidr}::cidr`;
    await audit(sql, {
      actorUserId: req.admin!.userId,
      action: 'ip_override.create',
      entity: 'ip_override',
      entityId: id,
      diff: { cidr, orgLabel: req.body.orgLabel },
      ip: req.clientIp,
    });
    return { id };
  });
  app.delete('/ip-overrides/:id', { ...editor, schema: { params: idParams } }, async (req) => {
    const r = await sql`DELETE FROM ip_org_overrides WHERE id = ${req.params.id} RETURNING id`;
    if (!r.length) throw notFound('override');
    await audit(sql, {
      actorUserId: req.admin!.userId,
      action: 'ip_override.delete',
      entity: 'ip_override',
      entityId: req.params.id,
      ip: req.clientIp,
    });
    return { ok: true };
  });
}
