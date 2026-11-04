import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit, parseCidr, QUEUES, type Sql } from '@vs/core';
import { idParams } from '@vs/shared';
import type { AppContext } from '../../context.js';
import { requireRecentAuth, requireRole } from '../../plugins/auth.js';
import { badRequest, notFound } from '../../lib/errors.js';

/** Data-subject request filter: by link, time, IP, IP prefix or viewer (at least one). */
export const subjectFilter = z
  .object({
    linkId: z.string().uuid().optional(),
    visitorId: z.string().uuid().optional(),
    ip: z.string().max(64).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .refine((f) => f.linkId || f.visitorId || f.ip, 'linkId, visitorId or ip is required');
type SubjectFilter = z.infer<typeof subjectFilter>;

function whereFor(sql: Sql, f: SubjectFilter) {
  let ipCond = sql``;
  if (f.ip) {
    const c = parseCidr(f.ip);
    if (!c) throw badRequest('invalid IP or prefix');
    ipCond = f.ip.includes('/')
      ? sql`AND s.ip <<= ${`${c[0].toString()}/${c[1]}`}::cidr`
      : sql`AND s.ip = ${c[0].toString()}::inet`;
  }
  return sql`WHERE true
    ${f.linkId ? sql`AND s.link_id = ${f.linkId}` : sql``}
    ${f.visitorId ? sql`AND s.visitor_id = ${f.visitorId}` : sql``}
    ${ipCond}
    ${f.from ? sql`AND s.started_at >= ${f.from}` : sql``}
    ${f.to ? sql`AND s.started_at <= ${f.to}` : sql``}`;
}

/**
 * Hard-deletes sessions and everything derived from them (events, segment fetches, summaries; browser
 * profiles and visitors that no longer have sessions) and queues a rollup rebuild for affected videos.
 */
export async function hardDeleteSessions(
  ctx: AppContext,
  sessionIds: string[],
): Promise<{ sessions: number; fingerprints: number; visitors: number }> {
  if (!sessionIds.length) return { sessions: 0, fingerprints: 0, visitors: 0 };
  const sql = ctx.database.sql;
  const r = await sql.begin(async (tx) => {
    const meta = await tx<{ video_id: string; fingerprint_id: string | null; visitor_id: string | null }[]>`
      SELECT video_id, fingerprint_id, visitor_id FROM view_sessions WHERE id = ANY(${sessionIds})`;
    await tx`DELETE FROM events WHERE session_id = ANY(${sessionIds})`;
    await tx`DELETE FROM segment_fetches WHERE session_id = ANY(${sessionIds})`;
    // archived segment partitions keep their (cascading) foreign key
    const del = await tx`DELETE FROM view_sessions WHERE id = ANY(${sessionIds})`;
    const fps = [...new Set(meta.map((m) => m.fingerprint_id).filter((x): x is string => !!x))];
    const vis = [...new Set(meta.map((m) => m.visitor_id).filter((x): x is string => !!x))];
    const f = fps.length
      ? await tx`DELETE FROM browser_fingerprints bf WHERE id = ANY(${fps}) AND NOT EXISTS (SELECT 1 FROM view_sessions s WHERE s.fingerprint_id = bf.id)`
      : { count: 0 };
    const v = vis.length
      ? await tx`DELETE FROM visitors v WHERE id = ANY(${vis}) AND NOT EXISTS (SELECT 1 FROM view_sessions s WHERE s.visitor_id = v.id)`
      : { count: 0 };
    return {
      sessions: del.count,
      fingerprints: f.count,
      visitors: v.count,
      videos: [...new Set(meta.map((m) => m.video_id))],
    };
  });
  for (const videoId of r.videos) await ctx.jobs.send(QUEUES.rollupsNightly, { videoId, full: true });
  return { sessions: r.sessions, fingerprints: r.fingerprints, visitors: r.visitors };
}

export async function gdprRoutes(fastify: FastifyInstance, ctx: AppContext) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const sql = ctx.database.sql;
  const owner = { preValidation: requireRole('owner') };
  const sensitive = { preValidation: [requireRole('owner'), requireRecentAuth(ctx)] };

  app.get('/gdpr/search', { ...owner, schema: { querystring: subjectFilter } }, async (req) => {
    const rows = await sql`
      SELECT s.id, s.started_at AS "startedAt", host(s.ip) AS ip, s.city, s.country, s.device_type AS device, l.label AS "linkLabel", v.title AS "videoTitle",
             s.visitor_id AS "visitorId"
      FROM view_sessions s JOIN share_links l ON l.id = s.link_id JOIN videos v ON v.id = s.video_id
      ${whereFor(sql, req.query)} ORDER BY s.started_at DESC LIMIT 5000`;
    await audit(sql, {
      actorUserId: req.admin!.userId,
      action: 'gdpr.search',
      diff: req.query,
      ip: req.clientIp,
    });
    return { sessions: rows, count: rows.length };
  });

  app.get('/gdpr/export', { ...sensitive, schema: { querystring: subjectFilter } }, async (req, reply) => {
    const ids = (
      await sql<{ id: string }[]>`SELECT s.id FROM view_sessions s ${whereFor(sql, req.query)} LIMIT 5000`
    ).map((r) => r.id);
    const [sessions, summaries, events, fetches, fingerprints, previews] = await Promise.all([
      sql`SELECT s.*, host(s.ip) AS ip_text, l.label AS link_label, v.title AS video_title FROM view_sessions s
          JOIN share_links l ON l.id = s.link_id JOIN videos v ON v.id = s.video_id WHERE s.id = ANY(${ids}) ORDER BY s.started_at`,
      sql`SELECT * FROM session_summaries WHERE session_id = ANY(${ids})`,
      sql`SELECT * FROM events WHERE session_id = ANY(${ids}) ORDER BY session_id, seq`,
      sql`SELECT * FROM segment_fetches WHERE session_id = ANY(${ids}) ORDER BY session_id, ts`,
      sql`SELECT bf.* FROM browser_fingerprints bf WHERE bf.id IN (SELECT fingerprint_id FROM view_sessions WHERE id = ANY(${ids}))`,
      req.query.ip
        ? sql`SELECT * FROM link_previews WHERE ip <<= ${req.query.ip}::inet`
        : Promise.resolve([]),
    ]);
    const intel =
      await sql`SELECT * FROM ip_intel WHERE id IN (SELECT ip_intel_id FROM view_sessions WHERE id = ANY(${ids}))`;
    await audit(sql, {
      actorUserId: req.admin!.userId,
      action: 'gdpr.export',
      diff: { ...req.query, sessions: ids.length },
      ip: req.clientIp,
    });
    reply.header(
      'content-disposition',
      `attachment; filename="data-subject-export-${new Date().toISOString().slice(0, 10)}.json"`,
    );
    return {
      exportedAt: new Date().toISOString(),
      filter: req.query,
      sessions,
      summaries,
      events,
      feedback: await sql`SELECT * FROM feedback WHERE session_id = ANY(${ids})`,
      segmentFetches: fetches,
      browserProfiles: fingerprints,
      ipOwnerData: intel,
      linkPreviews: previews,
    };
  });

  app.post(
    '/gdpr/delete',
    { ...sensitive, schema: { body: z.object({ filter: subjectFilter, confirm: z.literal(true) }) } },
    async (req) => {
      const ids = (
        await sql<{ id: string }[]>`SELECT s.id FROM view_sessions s ${whereFor(sql, req.body.filter)}`
      ).map((r) => r.id);
      const r = await hardDeleteSessions(ctx, ids);
      if (req.body.filter.ip) await sql`DELETE FROM link_previews WHERE ip <<= ${req.body.filter.ip}::inet`;
      await audit(sql, {
        actorUserId: req.admin!.userId,
        action: 'gdpr.delete',
        diff: { filter: req.body.filter, ...r },
        ip: req.clientIp,
      });
      return r;
    },
  );

  app.delete('/analytics/sessions/:id', { ...sensitive, schema: { params: idParams } }, async (req) => {
    const r = await hardDeleteSessions(ctx, [req.params.id]);
    if (!r.sessions) throw notFound('session');
    await audit(sql, {
      actorUserId: req.admin!.userId,
      action: 'gdpr.delete_session',
      entity: 'view_session',
      entityId: req.params.id,
      ip: req.clientIp,
    });
    return r;
  });
}
