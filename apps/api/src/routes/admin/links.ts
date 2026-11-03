import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit, diffObjects, newId, QUEUES, type DownloadJob } from '@vs/core';
import {
  checkCustomSlug,
  idParams,
  linkBulkSchema,
  linkCreateSchema,
  linkPatchSchema,
  pageQuery,
  parseBulkLinks,
  suggestSlug,
  type Cta,
} from '@vs/shared';
import type { AppContext } from '../../context.js';
import { requireRole } from '../../plugins/auth.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { hashPassword } from '../../lib/password.js';
import { linkState, slugAvailable, uniqueRandomSlug } from '../../lib/links.js';
import { offset, orderBy } from '../../lib/paging.js';

interface LinkRow {
  id: string;
  video_id: string;
  slug: string;
  label: string;
  recipient_name: string | null;
  recipient_org: string | null;
  note: string | null;
  password_hash: string | null;
  expires_at: Date | null;
  max_sessions: number | null;
  is_active: boolean;
  allow_download: boolean;
  allow_embed: boolean;
  notify_on_open: boolean;
  notify_every_open: boolean;
  story_mode: boolean | null;
  cta_config: Cta[] | null;
  session_count: number;
  first_opened_at: Date | null;
  last_opened_at: Date | null;
  created_at: Date;
  updated_at: Date;
  human_sessions?: number;
  max_completion?: number | null;
  previews?: number;
  video_title?: string;
}

export function serializeLink(ctx: AppContext, l: LinkRow) {
  return {
    id: l.id,
    videoId: l.video_id,
    videoTitle: l.video_title,
    slug: l.slug,
    url: `${ctx.config.publicOrigin}/v/${l.slug}`,
    label: l.label,
    recipientName: l.recipient_name,
    recipientOrg: l.recipient_org,
    note: l.note,
    hasPassword: !!l.password_hash,
    expiresAt: l.expires_at,
    maxSessions: l.max_sessions,
    isActive: l.is_active,
    allowDownload: l.allow_download,
    allowEmbed: l.allow_embed,
    notifyOnOpen: l.notify_on_open,
    notifyEveryOpen: l.notify_every_open,
    storyMode: l.story_mode,
    ctaConfig: l.cta_config,
    sessionCount: l.session_count,
    sessions: l.human_sessions ?? l.session_count,
    maxCompletion: l.max_completion ?? null,
    previews: l.previews ?? 0,
    firstOpenedAt: l.first_opened_at,
    lastOpenedAt: l.last_opened_at,
    createdAt: l.created_at,
    state: linkState(l),
  };
}

export async function linkRoutes(fastify: FastifyInstance, ctx: AppContext) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const sql = ctx.database.sql;
  const editor = { preValidation: requireRole('editor') };

  const linkStats = sql`
    (SELECT count(*)::int FROM view_sessions s WHERE s.link_id = l.id AND NOT s.is_bot) AS human_sessions,
    (SELECT max(ss.completion_pct)::float FROM session_summaries ss JOIN view_sessions s ON s.id = ss.session_id
       WHERE s.link_id = l.id AND NOT s.is_bot) AS max_completion,
    (SELECT count(*)::int FROM link_previews p WHERE p.link_id = l.id) AS previews`;

  const getLink = async (id: string): Promise<LinkRow> => {
    const r = await sql<
      LinkRow[]
    >`SELECT l.*, v.title AS video_title, ${linkStats} FROM share_links l JOIN videos v ON v.id = l.video_id
                                   WHERE l.id = ${id} AND l.deleted_at IS NULL`;
    if (!r[0]) throw notFound('link');
    return r[0];
  };

  const maybeQueueDownload = async (videoId: string, allow: boolean | undefined) => {
    if (allow)
      await ctx.jobs.send(QUEUES.makeDownload, { videoId } satisfies DownloadJob, { singletonKey: videoId });
  };

  app.get(
    '/slugs/check',
    { schema: { querystring: z.object({ slug: z.string().max(64), linkId: z.string().uuid().optional() }) } },
    async (req) => {
      const check = checkCustomSlug(req.query.slug);
      const available = check.ok ? await slugAvailable(sql, req.query.slug, req.query.linkId) : false;
      return { ...check, available, suggestion: suggestSlug(req.query.slug) };
    },
  );

  app.get(
    '/videos/:id/links',
    {
      schema: {
        params: idParams,
        querystring: pageQuery.extend({ state: z.enum(['active', 'closed', 'expired']).optional() }),
      },
    },
    async (req) => {
      const q = req.query;
      const { col, dir } = orderBy(
        q,
        {
          createdAt: 'l.created_at',
          label: 'l.label',
          recipient: 'l.recipient_name',
          sessions: 'human_sessions',
          lastOpened: 'l.last_opened_at',
          expires: 'l.expires_at',
          completion: 'max_completion',
        },
        'createdAt',
      );
      const where = sql`WHERE l.video_id = ${req.params.id} AND l.deleted_at IS NULL
        ${q.q ? sql`AND (l.label ILIKE ${'%' + q.q + '%'} OR l.recipient_name ILIKE ${'%' + q.q + '%'} OR l.recipient_org ILIKE ${'%' + q.q + '%'} OR l.slug ILIKE ${'%' + q.q + '%'})` : sql``}
        ${q.state === 'closed' ? sql`AND NOT l.is_active` : sql``}
        ${q.state === 'expired' ? sql`AND l.expires_at <= now()` : sql``}
        ${q.state === 'active' ? sql`AND l.is_active AND (l.expires_at IS NULL OR l.expires_at > now())` : sql``}`;
      const rows = await sql<LinkRow[]>`
        SELECT l.*, ${linkStats} FROM share_links l ${where}
        ORDER BY ${sql.unsafe(col)} ${sql.unsafe(dir)} NULLS LAST, l.id DESC LIMIT ${q.pageSize} OFFSET ${offset(q)}`;
      const total = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM share_links l ${where}`;
      return {
        items: rows.map((l) => serializeLink(ctx, l)),
        total: total[0]?.n ?? 0,
        page: q.page,
        pageSize: q.pageSize,
      };
    },
  );

  const createLink = async (
    videoId: string,
    body: z.output<typeof linkCreateSchema>,
    actor: string | null,
  ) => {
    let slug = body.slug;
    if (slug) {
      const c = checkCustomSlug(slug);
      if (!c.ok) throw badRequest(`invalid slug: ${c.reason}`);
      if (!(await slugAvailable(sql, slug))) throw conflict('slug already in use');
    } else slug = await uniqueRandomSlug(sql);
    const id = newId();
    const rows = await sql<LinkRow[]>`
      INSERT INTO share_links (id, video_id, slug, label, recipient_name, recipient_org, note, password_hash, expires_at, max_sessions,
                               is_active, allow_download, allow_embed, notify_on_open, notify_every_open, cta_config, story_mode, created_by)
      VALUES (${id}, ${videoId}, ${slug}, ${body.label}, ${body.recipientName ?? null}, ${body.recipientOrg ?? null}, ${body.note ?? null},
              ${body.password ? await hashPassword(body.password) : null}, ${body.expiresAt ?? null}, ${body.maxSessions ?? null},
              ${body.isActive}, ${body.allowDownload}, ${body.allowEmbed}, ${body.notifyOnOpen}, ${body.notifyEveryOpen},
              ${body.ctaConfig ? sql.json(body.ctaConfig as never) : null}, ${body.storyMode ?? null}, ${actor})
      RETURNING *`;
    return rows[0]!;
  };

  app.post(
    '/videos/:id/links',
    { ...editor, schema: { params: idParams, body: linkCreateSchema } },
    async (req) => {
      const v = await sql`SELECT 1 FROM videos WHERE id = ${req.params.id} AND deleted_at IS NULL`;
      if (!v.length) throw notFound('video');
      const link = await createLink(req.params.id, req.body, req.admin!.userId);
      await maybeQueueDownload(req.params.id, req.body.allowDownload);
      await audit(sql, {
        actorUserId: req.admin!.userId,
        action: 'link.create',
        entity: 'share_link',
        entityId: link.id,
        diff: { slug: link.slug, label: link.label, recipientName: link.recipient_name },
        ip: req.clientIp,
      });
      const guessable = req.body.slug
        ? ((checkCustomSlug(req.body.slug) as { guessable?: boolean }).guessable ?? false)
        : false;
      return { ...serializeLink(ctx, link), guessable };
    },
  );

  app.post(
    '/videos/:id/links/bulk',
    { ...editor, schema: { params: idParams, body: linkBulkSchema } },
    async (req) => {
      const v = await sql`SELECT 1 FROM videos WHERE id = ${req.params.id} AND deleted_at IS NULL`;
      if (!v.length) throw notFound('video');
      const rows = parseBulkLinks(req.body.csv);
      if (!rows.length) throw badRequest('no rows');
      if (rows.length > 500) throw badRequest('at most 500 rows');
      const created = [];
      for (const r of rows) {
        const body = linkCreateSchema.parse({
          label: r.label,
          recipientName: r.recipientName,
          recipientOrg: r.recipientOrg,
        });
        created.push(serializeLink(ctx, await createLink(req.params.id, body, req.admin!.userId)));
      }
      await audit(sql, {
        actorUserId: req.admin!.userId,
        action: 'link.bulk_create',
        entity: 'video',
        entityId: req.params.id,
        diff: { count: created.length },
        ip: req.clientIp,
      });
      return { created };
    },
  );

  app.get('/links/:id', { schema: { params: idParams } }, async (req) =>
    serializeLink(ctx, await getLink(req.params.id)),
  );

  app.patch('/links/:id', { ...editor, schema: { params: idParams, body: linkPatchSchema } }, async (req) => {
    const before = await getLink(req.params.id);
    const b = req.body;
    if (b.slug && b.slug !== before.slug) {
      const c = checkCustomSlug(b.slug);
      if (!c.ok) throw badRequest(`invalid slug: ${c.reason}`);
      if (!(await slugAvailable(sql, b.slug, before.id))) throw conflict('slug already in use');
      if (b.keepOldSlugRedirect) {
        await sql`INSERT INTO share_link_redirects (slug, link_id) VALUES (${before.slug}, ${before.id}) ON CONFLICT DO NOTHING`;
      }
    }
    const has = (k: keyof typeof b) => Object.prototype.hasOwnProperty.call(b, k);
    const passwordHash = has('password')
      ? b.password
        ? await hashPassword(b.password)
        : null
      : before.password_hash;
    const rows = await sql<LinkRow[]>`
      UPDATE share_links SET
        slug = ${b.slug ?? before.slug},
        label = ${b.label ?? before.label},
        recipient_name = ${has('recipientName') ? (b.recipientName ?? null) : before.recipient_name},
        recipient_org = ${has('recipientOrg') ? (b.recipientOrg ?? null) : before.recipient_org},
        note = ${has('note') ? (b.note ?? null) : before.note},
        password_hash = ${passwordHash},
        expires_at = ${has('expiresAt') ? (b.expiresAt ?? null) : before.expires_at},
        max_sessions = ${has('maxSessions') ? (b.maxSessions ?? null) : before.max_sessions},
        is_active = ${b.isActive ?? before.is_active},
        allow_download = ${b.allowDownload ?? before.allow_download},
        allow_embed = ${b.allowEmbed ?? before.allow_embed},
        notify_on_open = ${b.notifyOnOpen ?? before.notify_on_open},
        notify_every_open = ${b.notifyEveryOpen ?? before.notify_every_open},
        story_mode = ${has('storyMode') ? (b.storyMode ?? null) : before.story_mode},
        cta_config = ${has('ctaConfig') ? (b.ctaConfig ? sql.json(b.ctaConfig as never) : null) : before.cta_config ? sql.json(before.cta_config as never) : null},
        updated_at = now()
      WHERE id = ${before.id} RETURNING *`;
    await maybeQueueDownload(before.video_id, b.allowDownload);
    const { password_hash: _a, ...beforeSafe } = before;
    const { password_hash: _b, ...afterSafe } = rows[0]!;
    await audit(sql, {
      actorUserId: req.admin!.userId,
      action: 'link.update',
      entity: 'share_link',
      entityId: before.id,
      diff: { ...diffObjects(beforeSafe, afterSafe), ...(has('password') ? { password: '***' } : {}) },
      ip: req.clientIp,
    });
    return serializeLink(ctx, {
      ...rows[0]!,
      human_sessions: before.human_sessions,
      max_completion: before.max_completion,
    });
  });

  /** Deletes a link. With ?telemetry=true its sessions/events are hard-deleted too. */
  app.delete(
    '/links/:id',
    {
      ...editor,
      schema: { params: idParams, querystring: z.object({ telemetry: z.coerce.boolean().default(false) }) },
    },
    async (req) => {
      const l = await getLink(req.params.id);
      if (req.query.telemetry) {
        await sql`DELETE FROM share_links WHERE id = ${l.id}`; // cascades to sessions, events, previews, rollups
        await ctx.jobs.send(QUEUES.rollupsNightly, { videoId: l.video_id, full: true });
      } else {
        // keep the slug reserved so it can never point to another video
        await sql`UPDATE share_links SET deleted_at = now(), is_active = false WHERE id = ${l.id}`;
        await sql`DELETE FROM share_link_redirects WHERE link_id = ${l.id}`;
      }
      await audit(sql, {
        actorUserId: req.admin!.userId,
        action: 'link.delete',
        entity: 'share_link',
        entityId: l.id,
        diff: { slug: l.slug, telemetryDeleted: req.query.telemetry },
        ip: req.clientIp,
      });
      return { ok: true };
    },
  );
}
