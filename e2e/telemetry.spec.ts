import { test, expect, type APIRequestContext } from '@playwright/test';
import { adminSession } from './admin.js';
import { e2eState } from './global-setup.js';

async function newLink(request: APIRequestContext, label: string) {
  const s = await adminSession(request);
  const r = await request.post(`/api/admin/videos/${e2eState().videoId}/links`, {
    headers: s.headers,
    data: { label },
  });
  expect(r.ok()).toBeTruthy();
  return (await r.json()) as { id: string; slug: string };
}

const session = async (request: APIRequestContext, id: string) =>
  (await request.get(`/api/admin/analytics/sessions/${id}`)).json();

test('JS telemetry: play 0–30 %, seek to 60 %, play to 70 %, close', async ({ browser, request }) => {
  test.setTimeout(120_000);
  const link = await newLink(request, 'e2e telemetry');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`/v/${link.slug}`);
  const cfg = JSON.parse((await page.locator('#vs-config').textContent())!);
  const video = page.locator('video');
  await page.locator('.vs-big').click();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 30_000, intervals: [100] })
    .toBeGreaterThanOrEqual(9);
  await video.evaluate((v: HTMLVideoElement) => {
    v.pause();
    v.currentTime = 18;
  });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.seeking)).toBe(false);
  await video.evaluate((v: HTMLVideoElement) => v.play());
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000, intervals: [100] })
    .toBeGreaterThanOrEqual(21);
  await video.evaluate((v: HTMLVideoElement) => v.pause());
  await page.close({ runBeforeUnload: true });
  await ctx.close();

  await expect
    .poll(async () => (await session(request, cfg.sessionId)).summary?.exitReason, { timeout: 15_000 })
    .toBe('closed');
  const s = await session(request, cfg.sessionId);
  expect(s.summary.source).toBe('client');
  // 0–9 s plus 18–21 s; playback overshoots the polling a little
  expect(Math.abs(s.summary.uniqueWatchedMs - 12_000)).toBeLessThanOrEqual(1_000);
  expect(s.summary.quartiles).toEqual([25]);
  expect(s.summary.seekCount).toBeGreaterThanOrEqual(1);
  expect(s.events.map((e: { type: string }) => e.type)).toEqual(
    expect.arrayContaining(['page_view', 'fingerprint', 'play', 'heartbeat', 'seek', 'session_end']),
  );
});

test('JS disabled: no telemetry requests; segment log gives watched time ±8 s', async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const link = await newLink(request, 'e2e nojs');
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const page = await ctx.newPage();
  const telemetry: string[] = [];
  page.on('request', (r) => r.url().includes('/t/v1/') && telemetry.push(r.url()));
  await page.goto(`/v/${link.slug}`);
  const master = (await page.locator('video').getAttribute('src'))!;
  const sessionId = master.split('/')[4]!;
  await page.waitForTimeout(1000);
  expect(telemetry).toEqual([]);
  await ctx.close();

  // A native HLS player without page JS: playlists, then segments as the buffer drains (0–15 s of 30 s).
  const base = master.slice(0, master.lastIndexOf('/') + 1);
  expect((await request.get(master)).ok()).toBeTruthy();
  expect((await request.get(`${base}720p.m3u8`)).ok()).toBeTruthy();
  await request.get(`${base}720p_init.mp4`);
  const t0 = Date.now();
  for (const [at, i] of [
    [0, 0],
    [0, 1],
    [0, 2],
    [2000, 3],
    [6000, 4],
    [10000, 5],
    [14000, 6],
  ] as const) {
    const wait = t0 + at - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    expect((await request.get(`${base}720p_${String(i).padStart(5, '0')}.m4s`)).ok()).toBeTruthy();
  }
  await expect
    .poll(async () => (await session(request, sessionId)).segmentFetches?.length ?? 0, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(7);
  const s = await session(request, sessionId);
  expect(s.summary.source).toBe('server');
  expect(Math.abs(s.summary.uniqueWatchedMs - 15_000)).toBeLessThanOrEqual(8_000);
});

test('LinkedInBot is recorded as a link preview, not a session', async ({ request, playwright }) => {
  const link = await newLink(request, 'e2e preview');
  const bot = await playwright.request.newContext({
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080',
    userAgent: 'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
  });
  const r = await bot.get(`/v/${link.slug}`);
  expect(await r.text()).toContain('og:title');
  await bot.dispose();
  const l = await (await request.get(`/api/admin/links/${link.id}`)).json();
  expect(l.previews).toBe(1);
  expect(l.sessions).toBe(0);
});

test('same browser on two links → same visitor; LAN address classified as lan', async ({
  browser,
  request,
}) => {
  test.setTimeout(90_000);
  const a = await newLink(request, 'e2e visitor A');
  const b = await newLink(request, 'e2e visitor B');
  const ctx = await browser.newContext();
  const ids: string[] = [];
  for (const l of [a, b]) {
    const page = await ctx.newPage();
    await page.goto(`/v/${l.slug}`);
    ids.push(JSON.parse((await page.locator('#vs-config').textContent())!).sessionId);
    await page.waitForTimeout(1500); // fingerprint is sent in the first batch
    await page.close({ runBeforeUnload: true });
  }
  await ctx.close();
  await expect
    .poll(async () => (await session(request, ids[0]!)).visitor?.id ?? null, { timeout: 20_000 })
    .not.toBeNull();
  await expect
    .poll(async () => (await session(request, ids[1]!)).visitor?.id ?? null, { timeout: 20_000 })
    .toBe((await session(request, ids[0]!)).visitor.id);
  // the e2e client reaches nginx from a private (docker/loopback) address
  await expect
    .poll(async () => (await session(request, ids[0]!)).network?.type ?? null, { timeout: 20_000 })
    .toBe('lan');
});
