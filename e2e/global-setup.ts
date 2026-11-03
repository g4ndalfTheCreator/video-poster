import { request as pwRequest, type FullConfig } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { ensureFixtures, SAMPLE_1080P } from '../test/fixtures.js';
import { adminSession, tusUpload, waitForVideo } from './admin.js';

export const STATE_FILE = new URL('./.state.json', import.meta.url).pathname;

/** Uploads the 30 s 1080p sample once for all specs and stores its id in e2e/.state.json. */
export default async function globalSetup(config: FullConfig) {
  ensureFixtures();
  const baseURL = config.projects[0]?.use.baseURL ?? 'http://127.0.0.1:8080';
  const request = await pwRequest.newContext({ baseURL });
  const s = await adminSession(request);
  const id = await tusUpload(request, s, readFileSync(SAMPLE_1080P), 'sample-1080p.mp4', 'E2E sample');
  const v = await waitForVideo(request, id, 'ready', 300_000);
  if (v.status !== 'ready') throw new Error(`sample video failed: ${v.error}`);
  writeFileSync(STATE_FILE, JSON.stringify({ videoId: id }));
  await request.dispose();
}

export function e2eState(): { videoId: string } {
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { videoId: string };
}
