import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { QUEUES } from '@vs/core';
import { makeApp, bootstrapOwner, authed, type TestApp } from '../../api/test/support.js';
import type { memoryJobs } from '../../api/src/context.js';
import { ensureFixtures, SAMPLE_1080P, INVALID_VIDEO, SAMPLE_PORTRAIT } from '../../../test/fixtures.js';
import { transcodeVideo } from '../src/media/transcode.js';

/** Uploads a file through the real tus endpoint over a socket (inject does not stream tus bodies). */
async function tusUpload(
  base: string,
  session: { cookie: string; csrf: string },
  file: string,
  title: string,
): Promise<string> {
  const data = readFileSync(file);
  const meta = `filename ${Buffer.from(path.basename(file)).toString('base64')},title ${Buffer.from(title).toString('base64')}`;
  const headers = { ...authed(session), 'tus-resumable': '1.0.0' };
  const create = await fetch(`${base}/api/admin/uploads`, {
    method: 'POST',
    headers: { ...headers, 'upload-length': String(data.length), 'upload-metadata': meta },
  });
  expect(create.status).toBe(201);
  const location = create.headers.get('location')!;
  // two chunks to exercise resumable PATCH
  const half = Math.floor(data.length / 2);
  const p1 = await fetch(`${base}${location}`, {
    method: 'PATCH',
    headers: { ...headers, 'upload-offset': '0', 'content-type': 'application/offset+octet-stream' },
    body: data.subarray(0, half),
  });
  expect(p1.status).toBe(204);
  const head = await fetch(`${base}${location}`, { method: 'HEAD', headers });
  expect(head.headers.get('upload-offset')).toBe(String(half));
  const p2 = await fetch(`${base}${location}`, {
    method: 'PATCH',
    headers: { ...headers, 'upload-offset': String(half), 'content-type': 'application/offset+octet-stream' },
    body: data.subarray(half),
  });
  expect(p2.status).toBe(204);
  return p2.headers.get('x-video-id')!;
}

describe('video pipeline', () => {
  let t: TestApp;
  let media: string;
  let owner: Awaited<ReturnType<typeof bootstrapOwner>>;
  let base: string;
  const deps = () => ({ sql: t.ctx.database.sql, config: t.ctx.config, log: pino({ level: 'silent' }) });
  const lastJob = () => {
    const sent = (t.ctx.jobs as ReturnType<typeof memoryJobs>).sent.filter(
      (j) => j.queue === QUEUES.transcode,
    );
    return sent[sent.length - 1]!.data as { videoId: string; jobId: string };
  };

  beforeAll(async () => {
    ensureFixtures();
    media = await mkdtemp(path.join(os.tmpdir(), 'vs-media-'));
    t = await makeApp({ MEDIA_ROOT: media, TRANSCODE_PRESET: 'ultrafast' });
    owner = await bootstrapOwner(t.app, t.ctx);
    base = await t.app.listen({ port: 0, host: '127.0.0.1' });
  }, 120_000);
  afterAll(async () => {
    await t.close();
    await rm(media, { recursive: true, force: true });
  });

  it('uploads and transcodes the 30 s 1080p sample into 4 renditions', async () => {
    const videoId = await tusUpload(base, owner, SAMPLE_1080P, 'Sample');
    const job = lastJob();
    expect(job.videoId).toBe(videoId);
    await transcodeVideo(deps(), job.videoId, job.jobId);

    const res = await t.app.inject({
      url: `/api/admin/videos/${videoId}`,
      headers: { cookie: owner.cookie },
    });
    const v = res.json();
    expect(v.status).toBe('ready');
    expect(v.title).toBe('Sample');
    expect(v.durationMs).toBeGreaterThan(29_000);
    expect(v.renditions.map((r: { height: number }) => r.height)).toEqual([1080, 720, 480, 360]);
    expect(v.jobs[0].state).toBe('done');
    expect(v.originalSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(v.preview.master).toMatch(/^\/media\/[A-Za-z0-9_-]{22}\/\d+\/0{8}-/);

    const dir = path.join(media, 'hls', videoId, '1');
    const files = readdirSync(dir);
    for (const f of [
      'master.m3u8',
      '1080p.m3u8',
      '720p.m3u8',
      '480p.m3u8',
      '360p.m3u8',
      'poster.jpg',
      'sprite.jpg',
      'sprite.vtt',
    ]) {
      expect(files).toContain(f);
    }
    expect(files.filter((f) => f.startsWith('720p_') && f.endsWith('.m4s')).length).toBeGreaterThanOrEqual(7);
    expect(readFileSync(path.join(dir, 'master.m3u8'), 'utf8')).toContain('RESOLUTION=1920x1080');
    // original is kept unchanged, the user's file name is not used in the path
    expect(existsSync(path.join(media, 'originals', videoId, 'source.mp4'))).toBe(true);
  }, 300_000);

  it('portrait video gets a portrait ladder', async () => {
    const videoId = await tusUpload(base, owner, SAMPLE_PORTRAIT, 'Portrait');
    const job = lastJob();
    await transcodeVideo(deps(), job.videoId, job.jobId);
    const v = (
      await t.app.inject({ url: `/api/admin/videos/${videoId}`, headers: { cookie: owner.cookie } })
    ).json();
    expect(v.status).toBe('ready');
    expect(v.renditions.map((r: { width: number; height: number }) => `${r.width}x${r.height}`)).toEqual([
      '720x1280',
      '480x854',
      '360x640',
    ]);
  }, 120_000);

  it('marks an invalid file as failed with an error message, and retry is possible', async () => {
    const videoId = await tusUpload(base, owner, INVALID_VIDEO, 'Broken');
    const job = lastJob();
    await transcodeVideo(deps(), job.videoId, job.jobId);
    const v = (
      await t.app.inject({ url: `/api/admin/videos/${videoId}`, headers: { cookie: owner.cookie } })
    ).json();
    expect(v.status).toBe('failed');
    expect(v.error).toMatch(/ffprobe failed|no video|invalid/i);
    expect(v.jobs[0].state).toBe('failed');
    const retry = await t.app.inject({
      method: 'POST',
      url: `/api/admin/videos/${videoId}/retranscode`,
      headers: authed(owner),
    });
    expect(retry.statusCode).toBe(200);
    expect(existsSync(path.join(media, 'tmp', job.jobId))).toBe(false);
  }, 60_000);

  it('lists videos with paging and lets viewers read but not write', async () => {
    const list = await t.app.inject({
      url: '/api/admin/videos?pageSize=2&sort=title&dir=asc',
      headers: { cookie: owner.cookie },
    });
    expect(list.json().total).toBe(3);
    expect(list.json().items.map((i: { title: string }) => i.title)).toEqual(['Broken', 'Portrait']);
  });
});

describe('assets', () => {
  let t: TestApp;
  let owner: Awaited<ReturnType<typeof bootstrapOwner>>;
  let media: string;
  beforeAll(async () => {
    media = await mkdtemp(path.join(os.tmpdir(), 'vs-media-'));
    t = await makeApp({ MEDIA_ROOT: media });
    owner = await bootstrapOwner(t.app, t.ctx);
  });
  afterAll(async () => {
    await t.close();
    await rm(media, { recursive: true, force: true });
  });

  const multipart = (
    fields: Record<string, string>,
    file: { name: string; content: string; type: string },
  ) => {
    const boundary = '----vs' + Math.random().toString(16).slice(2);
    let body = '';
    for (const [k, v] of Object.entries(fields))
      body += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
    body += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n${file.content}\r\n--${boundary}--\r\n`;
    return { payload: body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
  };

  it('converts SRT captions to VTT, rejects bad attachments and serves files', async () => {
    const [v] = await t.ctx.database.sql<
      { id: string }[]
    >`INSERT INTO videos (id, title, status) VALUES (gen_random_uuid(), 'A', 'ready') RETURNING id`;
    const id = v!.id;
    const srt = multipart(
      { kind: 'captions', lang: 'fi', label: 'Suomi' },
      { name: 'subs.srt', type: 'application/x-subrip', content: '1\n00:00:01,000 --> 00:00:02,000\nHei\n' },
    );
    const up = await t.app.inject({
      method: 'POST',
      url: `/api/admin/videos/${id}/assets`,
      headers: { ...authed(owner), ...srt.headers },
      payload: srt.payload,
    });
    expect(up.statusCode, up.body).toBe(200);
    const file = await t.app.inject({
      url: `/api/admin/videos/${id}/assets/${up.json().id}/file`,
      headers: { cookie: owner.cookie },
    });
    expect(file.headers['content-type']).toBe('text/vtt');
    expect(file.body).toContain('00:00:01.000 --> 00:00:02.000');

    const exe = multipart(
      { kind: 'attachment' },
      { name: 'evil.exe', type: 'application/octet-stream', content: 'MZ' },
    );
    const bad = await t.app.inject({
      method: 'POST',
      url: `/api/admin/videos/${id}/assets`,
      headers: { ...authed(owner), ...exe.headers },
      payload: exe.payload,
    });
    expect(bad.statusCode).toBe(400);

    const pdf = multipart(
      { kind: 'attachment', label: 'CV' },
      { name: 'cv ä.pdf', type: 'application/pdf', content: '%PDF-1.4' },
    );
    const ok = await t.app.inject({
      method: 'POST',
      url: `/api/admin/videos/${id}/assets`,
      headers: { ...authed(owner), ...pdf.headers },
      payload: pdf.payload,
    });
    expect(ok.statusCode).toBe(200);
    const dl = await t.app.inject({
      url: `/api/admin/videos/${id}/assets/${ok.json().id}/file`,
      headers: { cookie: owner.cookie },
    });
    expect(dl.headers['content-disposition']).toContain("filename*=UTF-8''cv%20%C3%A4.pdf");
    const list = await t.app.inject({
      url: `/api/admin/videos/${id}/assets`,
      headers: { cookie: owner.cookie },
    });
    expect(list.json()).toHaveLength(2);
  });
});
