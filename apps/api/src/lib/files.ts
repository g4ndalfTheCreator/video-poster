import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyReply } from 'fastify';
import type { Config } from '@vs/core';
import { notFound } from './errors.js';

/** RFC 6266 Content-Disposition with an ASCII fallback. */
export function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Sends a file below MEDIA_ROOT. Behind nginx (MEDIA_ACCEL) the transfer is delegated with
 * X-Accel-Redirect; otherwise it is streamed by Node.
 */
export async function sendMediaFile(
  config: Config,
  reply: FastifyReply,
  relPath: string,
  opts: { mime: string; filename?: string; disposition?: 'inline' | 'attachment'; cache?: string },
) {
  const abs = path.resolve(config.MEDIA_ROOT, relPath);
  if (!abs.startsWith(path.resolve(config.MEDIA_ROOT) + path.sep)) throw notFound('file');
  const st = await stat(abs).catch(() => null);
  if (!st?.isFile()) throw notFound('file');
  reply.header('content-type', opts.mime);
  reply.header('x-content-type-options', 'nosniff');
  reply.header('cache-control', opts.cache ?? 'private, max-age=300');
  if (opts.filename)
    reply.header('content-disposition', contentDisposition(opts.disposition ?? 'attachment', opts.filename));
  if (config.MEDIA_ACCEL) {
    reply.header(
      'x-accel-redirect',
      `/_protected/${path.relative(config.MEDIA_ROOT, abs).split(path.sep).map(encodeURIComponent).join('/')}`,
    );
    return reply.send('');
  }
  reply.header('content-length', st.size);
  return reply.send(createReadStream(abs));
}
