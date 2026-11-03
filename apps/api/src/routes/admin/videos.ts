import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  audit,
  diffObjects,
  mediaPaths,
  newId,
  purgeVideo,
  QUEUES,
  VIDEO_EVENTS_CHANNEL,
  type TranscodeJob,
  type PosterJob,
} from '@vs/core';
import { idParams, posterSchema, videoListQuery, videoPatchSchema, srtToVtt, looksLikeVtt } from '@vs/shared';
import type { AppContext } from '../../context.js';
import { requireRole } from '../../plugins/auth.js';
import { badRequest, notFound, conflict } from '../../lib/errors.js';
import { offset, orderBy } from '../../lib/paging.js';
import { previewUrls } from '../../lib/media-urls.js';
import { startSse } from '../../lib/sse.js';
import type { PgNotifications } from '../../lib/notify.js';
import { sendMediaFile } from '../../lib/files.js';

const ATTACHMENT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  zip: 'application/zip',
};
const MAX_ATTACHMENT = 50 * 1024 * 1024;

export async function videoRoutes(fastify: FastifyInstance, ctx: AppContext, notifications: PgNotifications) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const sql = ctx.database.sql;
  const paths = mediaPaths(ctx.config.MEDIA_ROOT);
  const editor = { preValidation: requireRole('editor') };

  const loadVideo = async (id: string) => {
    const rows = await sql<
      Record<string, unknown>[]
    >`SELECT * FROM videos WHERE id = ${id} AND deleted_at IS NULL`;
    if (!rows[0]) throw notFound('video');
    return rows[0];
  };

  app.get('/videos', { schema: { querystring: videoListQuery } }, async (req) => {
    const q = req.query;
    const { col, dir } = orderBy(
      q,
      {
        createdAt: 'v.created_at',
        title: 'v.title',
        duration: 'v.duration_ms',
        status: 'v.status',
        links: 'link_count',
        sessions: 'sessions',
        completion: 'avg_completion',
      },
      'createdAt',
    );
    const where = sql`WHERE v.deleted_at IS NULL
      ${q.status ? sql`AND v.status = ${q.status}` : q.status === undefined ? sql`AND v.status <> 'archived'` : sql``}
      ${q.q ? sql`AND (v.title ILIKE ${'%' + q.q + '%'} OR v.description ILIKE ${'%' + q.q + '%'})` : sql``}`;
    const items = await sql<Record<string, unknown>[]>`
      SELECT v.id, v.title, v.status, v.duration_ms AS "durationMs", v.hls_version AS "hlsVersion", v.created_at AS "createdAt",
             v.width, v.height, v.error,
             (SELECT count(*)::int FROM share_links l WHERE l.video_id = v.id AND l.deleted_at IS NULL) AS link_count,
             (SELECT count(*)::int FROM view_sessions s WHERE s.video_id = v.id AND NOT s.is_bot) AS sessions,
             (SELECT round(avg(ss.completion_pct), 1)::float FROM session_summaries ss JOIN view_sessions s ON s.id = ss.session_id
               WHERE s.video_id = v.id AND NOT s.is_bot AND ss.unique_watched_ms >= 2000) AS avg_completion
      FROM videos v ${where}
      ORDER BY ${sql.unsafe(col)} ${sql.unsafe(dir)} NULLS LAST, v.id DESC
      LIMIT ${q.pageSize} OFFSET ${offset(q)}`;
    const total = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM videos v ${where}`;
    return {
      items: items.map((v) => ({
        ...v,
        linkCount: v.link_count,
        sessions: v.sessions,
        avgCompletion: v.avg_completion,
        posterUrl: previewUrls(ctx.config, v.id as string, v.hlsVersion as number)?.poster ?? null,
      })),
      total: total[0]?.n ?? 0,
      page: q.page,
      pageSize: q.pageSize,
    };
  });

  app.get('/videos/:id', { schema: { params: idParams } }, async (req) => {
    const v = await loadVideo(req.params.id);
    const version = v.hls_version as number;
    const [renditions, assets, jobs, linkCount] = await Promise.all([
      sql`SELECT height, width, bitrate_kbps AS "bitrateKbps", size_bytes AS "sizeBytes" FROM video_renditions
          WHERE video_id = ${req.params.id} AND hls_version = ${version} ORDER BY height DESC`,
      sql`SELECT id, kind, mime, size_bytes AS "sizeBytes", lang, label, filename, created_at AS "createdAt" FROM assets
          WHERE video_id = ${req.params.id} ORDER BY created_at`,
      sql`SELECT id, state, progress_pct AS "progressPct", error, created_at AS "createdAt", started_at AS "startedAt",
                 finished_at AS "finishedAt" FROM transcode_jobs WHERE video_id = ${req.params.id} ORDER BY created_at DESC LIMIT 10`,
      sql<
        { n: number }[]
      >`SELECT count(*)::int AS n FROM share_links WHERE video_id = ${req.params.id} AND deleted_at IS NULL`,
    ]);
    return {
      id: v.id,
      title: v.title,
      description: v.description,
      status: v.status,
      durationMs: v.duration_ms,
      width: v.width,
      height: v.height,
      hlsVersion: version,
      posterAtMs: v.poster_at_ms,
      autoplayMuted: v.autoplay_muted,
      loudnorm: v.loudnorm,
      ctaConfig: v.cta_config,
      error: v.error,
      originalSha256: v.original_sha256,
      originalSizeBytes: v.original_size_bytes,
      createdAt: v.created_at,
      updatedAt: v.updated_at,
      renditions,
      assets,
      jobs,
      linkCount: linkCount[0]?.n ?? 0,
      preview: previewUrls(ctx.config, v.id as string, version),
    };
  });

  app.patch(
    '/videos/:id',
    { ...editor, schema: { params: idParams, body: videoPatchSchema } },
    async (req) => {
      const before = await loadVideo(req.params.id);
      const b = req.body;
      if (b.status === 'ready' && before.status !== 'archived')
        throw badRequest('only archived videos can be restored to ready');
      if (b.status === 'archived' && before.status !== 'ready')
        throw badRequest('only ready videos can be archived');
      const rows = await sql<Record<string, unknown>[]>`
      UPDATE videos SET
        title = coalesce(${b.title ?? null}, title),
        description = coalesce(${b.description ?? null}, description),
        autoplay_muted = coalesce(${b.autoplayMuted ?? null}, autoplay_muted),
        loudnorm = coalesce(${b.loudnorm ?? null}, loudnorm),
        cta_config = coalesce(${b.ctaConfig ? sql.json(b.ctaConfig as never) : null}, cta_config),
        status = coalesce(${b.status ?? null}, status),
        updated_at = now()
      WHERE id = ${req.params.id} RETURNING *`;
      await audit(sql, {
        actorUserId: req.admin!.userId,
        action: 'video.update',
        entity: 'video',
        entityId: req.params.id,
        diff: diffObjects(before, rows[0]!),
        ip: req.clientIp,
      });
      return { ok: true };
    },
  );

  /** Soft delete to the trash (purged after 30 days); ?purge=true deletes files and telemetry now (owner). */
  app.delete(
    '/videos/:id',
    {
      ...editor,
      schema: { params: idParams, querystring: z.object({ purge: z.coerce.boolean().default(false) }) },
    },
    async (req) => {
      const id = req.params.id;
      if (req.query.purge) {
        if (req.admin!.role !== 'owner') throw badRequest('only owners can purge');
        await purgeVideo(sql, ctx.config.MEDIA_ROOT, id);
      } else {
        const r =
          await sql`UPDATE videos SET deleted_at = now() WHERE id = ${id} AND deleted_at IS NULL RETURNING id`;
        if (!r.length) throw notFound('video');
        await sql`UPDATE share_links SET is_active = false WHERE video_id = ${id}`;
      }
      await audit(sql, {
        actorUserId: req.admin!.userId,
        action: req.query.purge ? 'video.purge' : 'video.delete',
        entity: 'video',
        entityId: id,
        ip: req.clientIp,
      });
      return { ok: true };
    },
  );

  app.get('/videos-trash', async () => {
    return sql`SELECT id, title, deleted_at AS "deletedAt", deleted_at + interval '30 days' AS "purgeAt" FROM videos
               WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`;
  });

  app.post('/videos/:id/restore', { ...editor, schema: { params: idParams } }, async (req) => {
    const r =
      await sql`UPDATE videos SET deleted_at = NULL WHERE id = ${req.params.id} AND deleted_at IS NOT NULL RETURNING id`;
    if (!r.length) throw notFound('video');
    await audit(sql, {
      actorUserId: req.admin!.userId,
      action: 'video.restore',
      entity: 'video',
      entityId: req.params.id,
      ip: req.clientIp,
    });
    return { ok: true };
  });

  app.post('/videos/:id/retranscode', { ...editor, schema: { params: idParams } }, async (req) => {
    const v = await loadVideo(req.params.id);
    if (!v.original_path) throw badRequest('no original file');
    const running =
      await sql`SELECT 1 FROM transcode_jobs WHERE video_id = ${req.params.id} AND state IN ('queued', 'running')`;
    if (running.length) throw conflict('a transcode job is already queued or running');
    const jobId = newId();
    await sql`INSERT INTO transcode_jobs (id, video_id, state) VALUES (${jobId}, ${req.params.id}, 'queued')`;
    await sql`UPDATE videos SET status = CASE WHEN hls_version > 0 THEN status ELSE 'processing' END WHERE id = ${req.params.id}`;
    await ctx.jobs.send(QUEUES.transcode, { videoId: req.params.id, jobId } satisfies TranscodeJob);
    await audit(sql, {
      actorUserId: req.admin!.userId,
      action: 'video.retranscode',
      entity: 'video',
      entityId: req.params.id,
      ip: req.clientIp,
    });
    return { jobId };
  });

  app.get(
    '/videos/:id/jobs/:jobId/log',
    { ...editor, schema: { params: idParams.extend({ jobId: z.string().uuid() }) } },
    async (req, reply) => {
      const r = await sql<
        { ffmpeg_log: string | null }[]
      >`SELECT ffmpeg_log FROM transcode_jobs WHERE id = ${req.params.jobId} AND video_id = ${req.params.id}`;
      if (!r[0]) throw notFound('job');
      return reply.type('text/plain; charset=utf-8').send(r[0].ffmpeg_log ?? '');
    },
  );

  // Poster: JSON { atMs } picks a frame; multipart upload sets a custom image.
  app.post('/videos/:id/poster', { ...editor, schema: { params: idParams } }, async (req) => {
    const v = await loadVideo(req.params.id);
    if (!(v.hls_version as number)) throw badRequest('video is not ready');
    if (req.isMultipart()) {
      const file = await req.file({ limits: { fileSize: 10 * 1024 * 1024 } });
      if (!file || !/^image\/(jpeg|png|webp)$/.test(file.mimetype))
        throw badRequest('jpeg, png or webp image required');
      const buf = await file.toBuffer();
      const dir = paths.tmp('posters');
      await mkdir(dir, { recursive: true });
      const p = path.join(dir, `${newId()}.img`);
      await writeFile(p, buf);
      await ctx.jobs.send(QUEUES.poster, { videoId: req.params.id, imagePath: p } satisfies PosterJob);
    } else {
      const body = posterSchema.parse(req.body);
      await ctx.jobs.send(QUEUES.poster, { videoId: req.params.id, atMs: body.atMs } satisfies PosterJob);
    }
    await audit(sql, {
      actorUserId: req.admin!.userId,
      action: 'video.poster',
      entity: 'video',
      entityId: req.params.id,
      ip: req.clientIp,
    });
    return { ok: true };
  });

  // ---- assets: captions (VTT/SRT) and attachments
  app.get('/videos/:id/assets', { schema: { params: idParams } }, async (req) => {
    return sql`SELECT id, kind, mime, size_bytes AS "sizeBytes", lang, label, filename, created_at AS "createdAt"
               FROM assets WHERE video_id = ${req.params.id} AND kind IN ('captions', 'attachment') ORDER BY created_at`;
  });

  app.post('/videos/:id/assets', { ...editor, schema: { params: idParams } }, async (req) => {
    await loadVideo(req.params.id);
    if (!req.isMultipart()) throw badRequest('multipart/form-data required');
    const file = await req.file({ limits: { fileSize: MAX_ATTACHMENT } });
    if (!file) throw badRequest('file required');
    const fields = Object.fromEntries(
      Object.entries(file.fields).flatMap(([k, v]) =>
        v && !Array.isArray(v) && 'value' in v ? [[k, String(v.value)]] : [],
      ),
    ) as Record<string, string>;
    const kind = fields.kind === 'captions' ? 'captions' : 'attachment';
    const buf = await file.toBuffer();
    if (file.file.truncated) throw badRequest('file too large');
    const id = newId();
    const dir = paths.assets(req.params.id);
    await mkdir(dir, { recursive: true });
    const original = file.filename.slice(0, 200);
    const ext = original.split('.').pop()?.toLowerCase() ?? '';
    let data: Buffer = buf;
    let mime: string;
    let storedExt: string;
    if (kind === 'captions') {
      const lang = (fields.lang ?? '').toLowerCase();
      if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(lang))
        throw badRequest('captions require a language code (e.g. fi, en)');
      const text = buf.toString('utf8');
      if (ext === 'srt') data = Buffer.from(srtToVtt(text));
      else if (!looksLikeVtt(text)) throw badRequest('captions must be WebVTT or SRT');
      mime = 'text/vtt';
      storedExt = 'vtt';
    } else {
      mime = ATTACHMENT_MIME[ext] ?? '';
      if (!mime) throw badRequest(`attachment type not allowed: ${Object.keys(ATTACHMENT_MIME).join(', ')}`);
      storedExt = ext;
    }
    const filePath = path.join(dir, `${id}.${storedExt}`);
    await writeFile(filePath, data);
    await sql`INSERT INTO assets (id, video_id, kind, path, mime, size_bytes, lang, label, filename)
              VALUES (${id}, ${req.params.id}, ${kind}, ${path.relative(ctx.config.MEDIA_ROOT, filePath)}, ${mime}, ${data.length},
                      ${kind === 'captions' ? fields.lang!.toLowerCase() : null}, ${(fields.label ?? '').slice(0, 100) || null}, ${original})`;
    await audit(sql, {
      actorUserId: req.admin!.userId,
      action: 'asset.create',
      entity: 'asset',
      entityId: id,
      diff: { kind, filename: original },
      ip: req.clientIp,
    });
    return { id };
  });

  app.get(
    '/videos/:id/assets/:assetId/file',
    { schema: { params: idParams.extend({ assetId: z.string().uuid() }) } },
    async (req, reply) => {
      const r = await sql<{ path: string; mime: string; filename: string | null; kind: string }[]>`
      SELECT path, mime, filename, kind FROM assets WHERE id = ${req.params.assetId} AND video_id = ${req.params.id}`;
      if (!r[0]) throw notFound('asset');
      return sendMediaFile(ctx.config, reply, r[0].path, {
        mime: r[0].mime,
        filename: r[0].filename ?? `${r[0].kind}`,
        disposition: r[0].kind === 'captions' ? 'inline' : 'attachment',
      });
    },
  );

  app.delete(
    '/videos/:id/assets/:assetId',
    { ...editor, schema: { params: idParams.extend({ assetId: z.string().uuid() }) } },
    async (req) => {
      const r = await sql<
        { path: string }[]
      >`DELETE FROM assets WHERE id = ${req.params.assetId} AND video_id = ${req.params.id}
                                            AND kind IN ('captions', 'attachment') RETURNING path`;
      if (!r[0]) throw notFound('asset');
      await rm(path.join(ctx.config.MEDIA_ROOT, r[0].path), { force: true });
      await audit(sql, {
        actorUserId: req.admin!.userId,
        action: 'asset.delete',
        entity: 'asset',
        entityId: req.params.assetId,
        ip: req.clientIp,
      });
      return { ok: true };
    },
  );

  // ---- live progress (SSE)
  app.get('/videos/:id/events', { schema: { params: idParams } }, async (req, reply) => {
    let unsubscribe = () => {};
    const send = startSse(req, reply, () => unsubscribe());
    unsubscribe = notifications.subscribe(VIDEO_EVENTS_CHANNEL, (e) => {
      if ((e as { videoId?: string }).videoId === req.params.id) send('video', e);
    });
  });
  app.get('/videos-events', async (req, reply) => {
    let unsubscribe = () => {};
    const send = startSse(req, reply, () => unsubscribe());
    unsubscribe = notifications.subscribe(VIDEO_EVENTS_CHANNEL, (e) => send('video', e));
  });
}
