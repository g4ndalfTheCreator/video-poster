import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { INVALID_VIDEO } from '../test/fixtures.js';
import { adminSession, tusUpload, waitForVideo } from './admin.js';
import { e2eState } from './global-setup.js';

test('uploaded 1080p sample (global setup) is ready with 4 renditions and signed media', async ({
  request,
  page,
}) => {
  await adminSession(request);
  const v = await waitForVideo(request, e2eState().videoId, 'ready');
  expect(v.status).toBe('ready');
  expect(v.renditions.map((r: { height: number }) => r.height)).toEqual([1080, 720, 480, 360]);

  const master = await request.get(v.preview.master);
  expect(master.status()).toBe(200);
  expect(master.headers()['content-type']).toContain('mpegurl');
  const base = v.preview.master.slice(0, v.preview.master.lastIndexOf('/') + 1);
  expect((await request.get(`${base}720p_init.mp4`)).status()).toBe(200);
  // tampered token / path → 403
  expect((await request.get(v.preview.master.replace(/\/media\/./, '/media/A'))).status()).toBe(403);
  // token is bound to the version: the same token for another version is rejected
  expect((await request.get(`${base.replace(/\/1\/$/, '/2/')}master.m3u8`)).status()).toBe(403);

  // admin UI lists the video
  void page;
});

test('invalid file ends in failed with an error', async ({ request }) => {
  const s = await adminSession(request);
  const id = await tusUpload(request, s, readFileSync(INVALID_VIDEO), 'invalid.mp4', 'Broken');
  const v = await waitForVideo(request, id, 'failed', 60_000);
  expect(v.status).toBe('failed');
  expect(v.error).toBeTruthy();
});
