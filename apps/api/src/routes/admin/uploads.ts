import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Server } from '@tus/server';
import { FileStore } from '@tus/file-store';
import { audit, mediaPaths, newId, QUEUES, type TranscodeJob } from '@vs/core';
import type { AppContext } from '../../context.js';
import { requireRole } from '../../plugins/auth.js';

const ADMIN_HEADER = 'x-vs-admin-user';
const ALLOWED_EXT = new Set(['mp4', 'm4v', 'mov', 'mkv', 'webm']);

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

export function extensionOf(filename: string | null | undefined): string {
  const ext = (filename ?? '').split('.').pop()?.toLowerCase() ?? '';
  return ALLOWED_EXT.has(ext) ? ext : 'bin';
}

/** Moves a finished upload into originals/, hashes it and queues transcoding. */
export async function finalizeUpload(
  ctx: AppContext,
  videoId: string,
  uploadFile: string,
  filename: string | null,
  actor: string | null,
) {
  const sql = ctx.database.sql;
  const paths = mediaPaths(ctx.config.MEDIA_ROOT);
  const digest = await sha256(uploadFile);
  const dir = paths.originals(videoId);
  await mkdir(dir, { recursive: true });
  // The stored file name is generated; the user-supplied name is never used in a path.
  const target = path.join(dir, `source.${extensionOf(filename)}`);
  await rename(uploadFile, target);
  await rm(`${uploadFile}.json`, { force: true });
  const jobId = newId();
  const { size } = await import('node:fs/promises').then((fs) => fs.stat(target));
  await sql.begin(async (tx) => {
    await tx`UPDATE videos SET original_path = ${path.relative(ctx.config.MEDIA_ROOT, target)}, original_sha256 = ${digest},
             original_size_bytes = ${size}, status = 'processing', updated_at = now() WHERE id = ${videoId}`;
    await tx`INSERT INTO transcode_jobs (id, video_id, state) VALUES (${jobId}, ${videoId}, 'queued')`;
  });
  await ctx.jobs.send(QUEUES.transcode, { videoId, jobId } satisfies TranscodeJob);
  await audit(sql, {
    actorUserId: actor,
    action: 'video.upload',
    entity: 'video',
    entityId: videoId,
    diff: { sha256: digest, size },
  });
  return { jobId };
}

export async function uploadRoutes(app: FastifyInstance, ctx: AppContext) {
  const sql = ctx.database.sql;
  const paths = mediaPaths(ctx.config.MEDIA_ROOT);
  await mkdir(paths.uploads, { recursive: true });

  const tus = new Server({
    path: '/api/admin/uploads',
    datastore: new FileStore({ directory: paths.uploads }),
    maxSize: ctx.config.MAX_UPLOAD_BYTES,
    namingFunction: () => newId(),
    // Relative Location header: works behind any proxy/host name.
    generateUrl: (_req, { path: p, id }) => `${p}/${id}`,
    async onUploadCreate(req, upload) {
      const actor = req.headers.get(ADMIN_HEADER);
      const filename = (upload.metadata?.filename ?? upload.metadata?.name ?? 'video').slice(0, 255);
      const title = (upload.metadata?.title || filename.replace(/\.[^.]+$/, '') || 'Video').slice(0, 200);
      const videoId = newId();
      await sql`INSERT INTO videos (id, title, status, created_by) VALUES (${videoId}, ${title}, 'uploading', ${actor})`;
      return { metadata: { ...upload.metadata, videoId, filename } };
    },
    async onUploadFinish(req, upload) {
      const videoId = upload.metadata?.videoId;
      if (!videoId) throw { status_code: 400, body: 'missing video id' };
      const file = upload.storage?.path ?? path.join(paths.uploads, upload.id);
      await finalizeUpload(
        ctx,
        videoId,
        file,
        upload.metadata?.filename ?? null,
        req.headers.get(ADMIN_HEADER),
      );
      return { headers: { 'x-video-id': videoId } };
    },
  });

  app.addContentTypeParser('application/offset+octet-stream', (_req, _payload, done) => done(null));

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    // Pass the authenticated user to the tus hooks; never trust a client-supplied value.
    req.raw.headers[ADMIN_HEADER] = req.admin?.userId ?? '';
    reply.hijack();
    await tus.handle(req.raw, reply.raw);
  };
  const opts = { preValidation: requireRole('editor'), bodyLimit: ctx.config.MAX_UPLOAD_BYTES };
  for (const url of ['/uploads', '/uploads/*']) {
    app.route({ method: ['POST', 'PATCH', 'HEAD', 'DELETE', 'OPTIONS'], url, ...opts, handler });
  }
}
