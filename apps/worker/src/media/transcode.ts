import { mkdir, rm, rename, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import { mediaPaths, newId, publishVideoEvent, type Config, type Sql } from '@vs/core';
import {
  HLS_KEYFRAME_SECONDS,
  HLS_SEGMENT_SECONDS,
  SPRITE_COLUMNS,
  SPRITE_INTERVAL_SECONDS,
  SPRITE_THUMB_WIDTH,
} from '@vs/shared';
import { runFfprobe, validateProbe, ValidationError, type MediaInfo } from './probe.js';
import { computeLadder, spriteVtt, type Rung } from './ladder.js';
import { runFfmpeg, FfmpegError } from './ffmpeg.js';

export interface MediaDeps {
  sql: Sql;
  config: Config;
  log: Logger;
}

export function buildHlsArgs(
  input: string,
  outDir: string,
  info: MediaInfo,
  rungs: Rung[],
  opts: { preset: string; loudnorm: boolean },
): string[] {
  const n = rungs.length;
  const portrait = info.height > info.width;
  const vf = [`[0:v]split=${n}${rungs.map((_, i) => `[vs${i}]`).join('')}`];
  rungs.forEach((r, i) =>
    vf.push(
      `[vs${i}]scale=${portrait ? `${r.width}:-2` : `-2:${r.height}`}:flags=bicubic,format=yuv420p[v${i}]`,
    ),
  );
  if (info.hasAudio) {
    const pre = opts.loudnorm ? 'loudnorm=I=-16:TP=-1.5:LRA=11,' : '';
    vf.push(`[0:a]${pre}aresample=48000,asplit=${n}${rungs.map((_, i) => `[a${i}]`).join('')}`);
  }
  const args = ['-i', input, '-filter_complex', vf.join(';')];
  rungs.forEach((r, i) => {
    args.push('-map', `[v${i}]`);
    if (info.hasAudio) args.push('-map', `[a${i}]`);
    args.push(
      `-b:v:${i}`,
      `${r.bitrateKbps}k`,
      `-maxrate:v:${i}`,
      `${Math.round(r.bitrateKbps * 1.07)}k`,
      `-bufsize:v:${i}`,
      `${Math.round(r.bitrateKbps * 1.5)}k`,
    );
  });
  args.push(
    '-c:v',
    'libx264',
    '-preset',
    opts.preset,
    '-profile:v',
    'high',
    '-force_key_frames',
    `expr:gte(t,n_forced*${HLS_KEYFRAME_SECONDS})`,
    '-sc_threshold',
    '0',
  );
  if (info.hasAudio) args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2');
  const varMap = rungs
    .map((r, i) => (info.hasAudio ? `v:${i},a:${i},name:${r.name}` : `v:${i},name:${r.name}`))
    .join(' ');
  args.push(
    '-f',
    'hls',
    '-hls_time',
    String(HLS_SEGMENT_SECONDS),
    '-hls_playlist_type',
    'vod',
    '-hls_segment_type',
    'fmp4',
    '-hls_flags',
    'independent_segments',
    '-hls_fmp4_init_filename',
    '%v_init.mp4',
    '-hls_segment_filename',
    path.join(outDir, '%v_%05d.m4s'),
    '-master_pl_name',
    'master.m3u8',
    '-var_stream_map',
    varMap,
    path.join(outDir, '%v.m3u8'),
  );
  return args;
}

export async function makePoster(
  input: string,
  out: string,
  atMs: number,
  info: Pick<MediaInfo, 'width' | 'height'>,
): Promise<void> {
  const scale = info.width >= info.height ? "scale='min(1280,iw)':-2" : "scale=-2:'min(1280,ih)'";
  await runFfmpeg([
    '-ss',
    (atMs / 1000).toFixed(3),
    '-i',
    input,
    '-frames:v',
    '1',
    '-vf',
    scale,
    '-q:v',
    '3',
    out,
  ]);
}

export async function makeSprite(
  input: string,
  outDir: string,
  info: MediaInfo,
): Promise<{ thumbH: number }> {
  const count = Math.max(1, Math.ceil(info.durationMs / 1000 / SPRITE_INTERVAL_SECONDS));
  const rows = Math.ceil(count / SPRITE_COLUMNS);
  const thumbH = Math.max(2, Math.round((SPRITE_THUMB_WIDTH * info.height) / info.width / 2) * 2);
  await runFfmpeg([
    '-i',
    input,
    '-vf',
    `fps=1/${SPRITE_INTERVAL_SECONDS},scale=${SPRITE_THUMB_WIDTH}:${thumbH},tile=${SPRITE_COLUMNS}x${rows}`,
    '-frames:v',
    '1',
    '-q:v',
    '5',
    path.join(outDir, 'sprite.jpg'),
  ]);
  await writeFile(
    path.join(outDir, 'sprite.vtt'),
    spriteVtt(info.durationMs, SPRITE_INTERVAL_SECONDS, SPRITE_THUMB_WIDTH, thumbH, SPRITE_COLUMNS),
  );
  return { thumbH };
}

async function dirSizeByPrefix(dir: string): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  for (const f of await readdir(dir)) {
    const prefix = f.split(/[_.]/)[0]!;
    const s = await stat(path.join(dir, f));
    sizes.set(prefix, (sizes.get(prefix) ?? 0) + s.size);
  }
  return sizes;
}

async function updateJob(
  sql: Sql,
  jobId: string,
  fields: {
    state?: string;
    progress?: number;
    error?: string | null;
    log?: string | null;
    started?: boolean;
    finished?: boolean;
  },
) {
  await sql`
    UPDATE transcode_jobs SET
      state = coalesce(${fields.state ?? null}, state),
      progress_pct = coalesce(${fields.progress ?? null}::numeric, progress_pct),
      error = CASE WHEN ${fields.error !== undefined} THEN ${fields.error ?? null} ELSE error END,
      ffmpeg_log = CASE WHEN ${fields.log !== undefined} THEN ${fields.log ?? null} ELSE ffmpeg_log END,
      started_at = CASE WHEN ${!!fields.started} THEN now() ELSE started_at END,
      finished_at = CASE WHEN ${!!fields.finished} THEN now() ELSE finished_at END
    WHERE id = ${jobId}`;
}

/**
 * Transcodes a video's original into a new HLS version. Idempotent per job: the work directory is
 * recreated and only atomically renamed into place when everything succeeded.
 */
export async function transcodeVideo(deps: MediaDeps, videoId: string, jobId: string): Promise<void> {
  const { sql, config, log } = deps;
  const paths = mediaPaths(config.MEDIA_ROOT);
  const rows = await sql<
    { original_path: string | null; hls_version: number; poster_at_ms: number | null; loudnorm: boolean }[]
  >`
    SELECT original_path, hls_version, poster_at_ms, loudnorm FROM videos WHERE id = ${videoId} AND deleted_at IS NULL`;
  const video = rows[0];
  if (!video?.original_path) throw new Error(`video ${videoId} has no original`);
  const input = path.join(config.MEDIA_ROOT, video.original_path);
  const work = paths.tmp(jobId);
  let lastLog = '';

  await updateJob(sql, jobId, { state: 'running', progress: 0, started: true, error: null });
  await sql`UPDATE videos SET status = 'processing', error = NULL, updated_at = now() WHERE id = ${videoId}`;
  await publishVideoEvent(sql, { videoId, type: 'status', status: 'processing' });

  try {
    const info = validateProbe(await runFfprobe(input), config.MAX_DURATION_S);
    await sql`UPDATE videos SET duration_ms = ${info.durationMs}, width = ${info.width}, height = ${info.height} WHERE id = ${videoId}`;
    const rungs = computeLadder(info.width, info.height);
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });

    let lastReport = 0;
    lastLog = await runFfmpeg(
      buildHlsArgs(input, work, info, rungs, { preset: config.TRANSCODE_PRESET, loudnorm: video.loudnorm }),
      (outMs) => {
        const pct = Math.min(95, (outMs / info.durationMs) * 95);
        if (Date.now() - lastReport > 1500) {
          lastReport = Date.now();
          void updateJob(sql, jobId, { progress: Math.round(pct * 100) / 100 });
          void publishVideoEvent(sql, { videoId, type: 'progress', progressPct: pct, stage: 'hls' });
        }
      },
    );
    const posterAt = video.poster_at_ms ?? Math.round(info.durationMs * 0.1);
    await makePoster(
      input,
      path.join(work, 'poster.jpg'),
      Math.min(posterAt, Math.max(0, info.durationMs - 100)),
      info,
    );
    await publishVideoEvent(sql, { videoId, type: 'progress', progressPct: 97, stage: 'images' });
    await makeSprite(input, work, info);

    const version = video.hls_version + 1;
    const target = paths.hls(videoId, version);
    await rm(target, { recursive: true, force: true });
    await mkdir(paths.hls(videoId), { recursive: true });
    await rename(work, target);

    const sizes = await dirSizeByPrefix(target);
    const fileSize = async (f: string) => (await stat(path.join(target, f))).size;
    const rel = (f: string) => path.relative(config.MEDIA_ROOT, path.join(target, f));
    const posterId = newId();
    await sql.begin(async (tx) => {
      for (const r of rungs) {
        await tx`
          INSERT INTO video_renditions (id, video_id, hls_version, height, width, bitrate_kbps, codec, playlist_path, size_bytes)
          VALUES (${newId()}, ${videoId}, ${version}, ${r.height}, ${r.width}, ${r.bitrateKbps}, 'avc1.640028,mp4a.40.2',
                  ${rel(`${r.name}.m3u8`)}, ${sizes.get(r.name) ?? 0})`;
      }
      await tx`DELETE FROM assets WHERE video_id = ${videoId} AND kind IN ('poster', 'sprite', 'sprite_vtt', 'download_mp4')`;
      await tx`INSERT INTO assets (id, video_id, kind, path, mime, size_bytes, hls_version) VALUES
        (${posterId}, ${videoId}, 'poster', ${rel('poster.jpg')}, 'image/jpeg', ${await fileSize('poster.jpg')}, ${version}),
        (${newId()}, ${videoId}, 'sprite', ${rel('sprite.jpg')}, 'image/jpeg', ${await fileSize('sprite.jpg')}, ${version}),
        (${newId()}, ${videoId}, 'sprite_vtt', ${rel('sprite.vtt')}, 'text/vtt', ${await fileSize('sprite.vtt')}, ${version})`;
      await tx`UPDATE videos SET status = 'ready', hls_version = ${version}, poster_asset_id = ${posterId},
               poster_at_ms = ${posterAt}, error = NULL, updated_at = now() WHERE id = ${videoId}`;
      await tx`UPDATE transcode_jobs SET state = 'done', progress_pct = 100, finished_at = now(), ffmpeg_log = ${lastLog.slice(-64 * 1024)}
               WHERE id = ${jobId}`;
    });
    await publishVideoEvent(sql, { videoId, type: 'status', status: 'ready', progressPct: 100 });
    await pruneOldVersions(config.MEDIA_ROOT, videoId, version);
    log.info({ videoId, version, renditions: rungs.map((r) => r.name) }, 'transcode done');
  } catch (err) {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    const message =
      err instanceof ValidationError
        ? err.message
        : err instanceof FfmpegError
          ? `ffmpeg failed: ${err.message}`
          : (err as Error).message;
    const tail = err instanceof FfmpegError ? err.logTail : lastLog;
    await updateJob(sql, jobId, {
      state: 'failed',
      error: message,
      log: tail.slice(-64 * 1024),
      finished: true,
    });
    // A failed re-transcode keeps a previously ready version playable.
    await sql`UPDATE videos SET status = CASE WHEN hls_version > 0 THEN 'ready' ELSE 'failed' END, error = ${message}, updated_at = now()
              WHERE id = ${videoId}`;
    await publishVideoEvent(sql, { videoId, type: 'status', status: 'failed', error: message });
    log.warn({ videoId, err: message }, 'transcode failed');
  }
}

/** Keeps the current and the previous HLS version (viewers in the middle of a video keep working). */
async function pruneOldVersions(root: string, videoId: string, current: number) {
  const dir = mediaPaths(root).hls(videoId);
  for (const v of await readdir(dir)) {
    const n = Number(v);
    if (Number.isInteger(n) && n < current - 1) await rm(path.join(dir, v), { recursive: true, force: true });
  }
}

/** Regenerates poster.jpg of the current version from the original at a given timestamp. */
export async function regeneratePoster(deps: MediaDeps, videoId: string, atMs: number): Promise<void> {
  const { sql, config } = deps;
  const rows = await sql<
    { original_path: string; hls_version: number; width: number; height: number; duration_ms: number }[]
  >`
    SELECT original_path, hls_version, width, height, duration_ms FROM videos WHERE id = ${videoId}`;
  const v = rows[0];
  if (!v || v.hls_version === 0) return;
  const dir = mediaPaths(config.MEDIA_ROOT).hls(videoId, v.hls_version);
  const tmp = path.join(dir, `poster.tmp.jpg`);
  await makePoster(
    path.join(config.MEDIA_ROOT, v.original_path),
    tmp,
    Math.min(atMs, Math.max(0, v.duration_ms - 100)),
    v,
  );
  await rename(tmp, path.join(dir, 'poster.jpg'));
  await sql`UPDATE videos SET poster_at_ms = ${atMs}, updated_at = now() WHERE id = ${videoId}`;
  await sql`UPDATE assets SET size_bytes = ${(await stat(path.join(dir, 'poster.jpg'))).size} WHERE video_id = ${videoId} AND kind = 'poster'`;
  await publishVideoEvent(sql, { videoId, type: 'status', status: 'ready', stage: 'poster' });
}

/** Converts an uploaded custom poster image to poster.jpg of the current version. */
export async function importPoster(deps: MediaDeps, videoId: string, imagePath: string): Promise<void> {
  const { sql, config } = deps;
  const rows = await sql<{ hls_version: number }[]>`SELECT hls_version FROM videos WHERE id = ${videoId}`;
  const v = rows[0];
  if (!v || v.hls_version === 0) return;
  const dir = mediaPaths(config.MEDIA_ROOT).hls(videoId, v.hls_version);
  const tmp = path.join(dir, 'poster.tmp.jpg');
  await runFfmpeg(['-i', imagePath, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '3', tmp]);
  await rename(tmp, path.join(dir, 'poster.jpg'));
  await rm(imagePath, { force: true });
  await sql`UPDATE videos SET poster_at_ms = NULL, updated_at = now() WHERE id = ${videoId}`;
  await publishVideoEvent(sql, { videoId, type: 'status', status: 'ready', stage: 'poster' });
}

/** 720p (or the highest rung below) progressive MP4 for links with allow_download. */
export async function makeDownload(deps: MediaDeps, videoId: string): Promise<void> {
  const { sql, config } = deps;
  const rows = await sql<{ original_path: string; hls_version: number; width: number; height: number }[]>`
    SELECT original_path, hls_version, width, height FROM videos WHERE id = ${videoId} AND status = 'ready'`;
  const v = rows[0];
  if (!v) return;
  const existing =
    await sql`SELECT 1 FROM assets WHERE video_id = ${videoId} AND kind = 'download_mp4' AND hls_version = ${v.hls_version}`;
  if (existing.length) return;
  const dir = mediaPaths(config.MEDIA_ROOT).hls(videoId, v.hls_version);
  const short = Math.min(v.width, v.height, 720);
  const scale = v.height > v.width ? `${short}:-2` : `-2:${short}`;
  const tmp = path.join(dir, 'download.tmp.mp4');
  await runFfmpeg([
    '-i',
    path.join(config.MEDIA_ROOT, v.original_path),
    '-vf',
    `scale=${scale},format=yuv420p`,
    '-c:v',
    'libx264',
    '-preset',
    config.TRANSCODE_PRESET,
    '-crf',
    '22',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    tmp,
  ]);
  await rename(tmp, path.join(dir, 'download.mp4'));
  const size = (await stat(path.join(dir, 'download.mp4'))).size;
  await sql`INSERT INTO assets (id, video_id, kind, path, mime, size_bytes, hls_version)
            VALUES (${newId()}, ${videoId}, 'download_mp4', ${path.relative(config.MEDIA_ROOT, path.join(dir, 'download.mp4'))},
                    'video/mp4', ${size}, ${v.hls_version})`;
}
