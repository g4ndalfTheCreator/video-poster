import { createHash } from 'node:crypto';
import path from 'node:path';

/** Session id used for admin previews and Open Graph images (not attributed to any viewer). */
export const PREVIEW_SESSION = '00000000-0000-0000-0000-000000000000';

export const mediaPaths = (root: string) => ({
  uploads: path.join(root, 'uploads'),
  originals: (videoId: string) => path.join(root, 'originals', videoId),
  hls: (videoId: string, version?: number) =>
    version === undefined
      ? path.join(root, 'hls', videoId)
      : path.join(root, 'hls', videoId, String(version)),
  assets: (videoId: string) => path.join(root, 'assets', videoId),
  tmp: (id: string) => path.join(root, 'tmp', id),
});

/**
 * Signed media URL validated by nginx `secure_link_md5 "$exp$session$video$version $key"`.
 * Layout: /media/<token>/<exp>/<session>/<video>/<version>/<file>
 */
export function signMediaUrl(opts: {
  key: string;
  sessionId: string;
  videoId: string;
  version: number;
  file: string;
  ttlSec: number;
  nowSec?: number;
}): string {
  const exp = Math.floor((opts.nowSec ?? Date.now() / 1000) + opts.ttlSec);
  const token = createHash('md5')
    .update(`${exp}${opts.sessionId}${opts.videoId}${opts.version} ${opts.key}`)
    .digest('base64url');
  return `/media/${token}/${exp}/${opts.sessionId}/${opts.videoId}/${opts.version}/${opts.file}`;
}

/** Base path (directory) of a signed media URL, used to resolve relative files such as sprite.jpg. */
export function signedMediaBase(url: string): string {
  return url.slice(0, url.lastIndexOf('/') + 1);
}

/** Hard-deletes a video row (cascades to links and telemetry) and its files. */
export async function purgeVideo(sql: import('./db.js').Sql, mediaRoot: string, id: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  const p = mediaPaths(mediaRoot);
  await sql`DELETE FROM videos WHERE id = ${id}`;
  for (const dir of [p.originals(id), p.hls(id), p.assets(id)])
    await rm(dir, { recursive: true, force: true });
}
