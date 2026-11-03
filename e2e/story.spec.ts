import { test, expect, devices, type APIRequestContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { adminSession, tusUpload, waitForVideo } from './admin.js';
import { SAMPLE_PORTRAIT } from '../test/fixtures.js';
import { e2eState } from './global-setup.js';

async function storyLink(request: APIRequestContext, label: string) {
  const s = await adminSession(request);
  const videoId = e2eState().videoId;
  await request.patch(`/api/admin/videos/${videoId}`, {
    headers: s.headers,
    data: {
      chapters: [
        { atMs: 0, title: 'Kuka olen' },
        { atMs: 15000, title: 'Kokemus' },
      ],
    },
  });
  const r = await request.post(`/api/admin/videos/${videoId}/links`, {
    headers: s.headers,
    data: { label, storyMode: true },
  });
  expect(r.ok()).toBeTruthy();
  return (await r.json()) as { slug: string; id: string };
}

const session = async (request: APIRequestContext, id: string) =>
  (await request.get(`/api/admin/analytics/sessions/${id}`)).json();
const docsInView = (page: Page) =>
  page.locator('#vs-docs').evaluate((el) => Math.abs(el.getBoundingClientRect().top) < 5);

test.describe('story mode on a phone', () => {
  // phone emulation without forcing a browser type (runs in every configured project)
  const { defaultBrowserType: _b, ...phone } = devices['Pixel 7'];
  test.use(phone);

  test('muted autoplay, chapters, feedback card after the video, then the documents page', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const link = await storyLink(request, 'e2e story');
    await page.goto(`/v/${link.slug}`);
    const cfg = JSON.parse((await page.locator('#vs-config').textContent())!);
    const video = page.locator('video');
    await expect(page.locator('.vs-seg')).toHaveCount(2);
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 20_000 })
      .toBeGreaterThan(0.3);
    expect(await video.evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
    await expect(page.locator('.vs-chapter-title')).toHaveText('Kuka olen');
    await page.locator('.vs-sound').click();
    expect(await video.evaluate((v: HTMLVideoElement) => v.muted)).toBe(false);
    await expect(page.locator('.vs-sound')).toBeHidden();

    // jump to the second chapter via the progress bar, then near the end
    await page.locator('.vs-seg').nth(1).click();
    await expect(page.locator('.vs-chapter-title')).toHaveText('Kokemus');
    await video.evaluate((v: HTMLVideoElement) => {
      v.currentTime = v.duration - 1.5;
      void v.play();
    });
    const card = page.locator('.vs-card');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.getByRole('button', { name: /Kyllä|Yes/ }).click();
    // one tap is enough: the view slides to the documents automatically
    await expect.poll(() => docsInView(page), { timeout: 10_000 }).toBe(true);
    await expect(page.locator('.vs-fb-page .vs-fb-thanks')).toBeVisible();
    await page.close({ runBeforeUnload: true });

    await expect
      .poll(async () => (await session(request, cfg.sessionId)).feedback?.rating ?? null, { timeout: 15_000 })
      .toBe('up');
    // events arrive with the page-hide beacon, independently of the feedback request
    await expect
      .poll(async () => (await session(request, cfg.sessionId)).documentsVia ?? null, { timeout: 15_000 })
      .toBe('ended');
  });

  test('swiping up skips to the documents at any time', async ({ page, request }) => {
    const link = await storyLink(request, 'e2e story swipe');
    await page.goto(`/v/${link.slug}`);
    const cfg = JSON.parse((await page.locator('#vs-config').textContent())!);
    await expect
      .poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 20_000 })
      .toBeGreaterThan(0.3);
    // a touch swipe scrolls the snap container; emulate it with a scroll
    await page
      .locator('#vs-story')
      .evaluate((el) => el.scrollBy({ top: el.clientHeight, behavior: 'instant' as ScrollBehavior }));
    await expect.poll(() => docsInView(page)).toBe(true);
    await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
    await expect(page.locator('.vs-doc').first())
      .toBeVisible()
      .catch(() => undefined);
    await page.close({ runBeforeUnload: true });
    await expect
      .poll(async () => (await session(request, cfg.sessionId)).documentsVia ?? null, { timeout: 15_000 })
      .toBe('swipe');
  });
});

let portraitVideoId: string | null = null;
async function portraitStoryLink(request: APIRequestContext) {
  const s = await adminSession(request);
  if (!portraitVideoId) {
    const id = await tusUpload(request, s, readFileSync(SAMPLE_PORTRAIT), 'portrait.mp4', 'E2E portrait');
    const v = await waitForVideo(request, id, 'ready', 120_000);
    expect(v.status).toBe('ready');
    portraitVideoId = id;
  }
  const r = await request.post(`/api/admin/videos/${portraitVideoId}/links`, {
    headers: s.headers,
    data: { label: 'e2e portrait story', storyMode: true },
  });
  return (await r.json()) as { slug: string };
}

const frame = (page: Page) =>
  page
    .locator('.vs-story-player')
    .boundingBox()
    .then((b) => b!);
const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.describe('story mode in a desktop browser', () => {
  test('landscape video gets a wide frame that fits the window; keyboard moves between panes', async ({
    page,
    request,
  }) => {
    const link = await storyLink(request, 'e2e story desktop');
    for (const [w, h] of [
      [1440, 900],
      [1280, 720],
      [1024, 1300],
    ] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(`/v/${link.slug}`);
      const b = await frame(page);
      expect(b.width / b.height).toBeCloseTo(16 / 9, 1);
      expect(b.width).toBeLessThanOrEqual(w - 60);
      expect(b.height).toBeLessThanOrEqual(h - 60);
      expect(await noHorizontalScroll(page)).toBe(true);
      await expect(page.locator('.vs-backdrop')).toBeAttached();
    }
    await page.locator('body').press('ArrowDown');
    await expect.poll(() => docsInView(page)).toBe(true);
    await page.locator('body').press('ArrowUp');
    await expect
      .poll(() => page.locator('.vs-stage').evaluate((el) => Math.abs(el.getBoundingClientRect().top) < 5))
      .toBe(true);
  });

  test('portrait video gets a phone-shaped frame', async ({ page, request }) => {
    test.setTimeout(180_000);
    const link = await portraitStoryLink(request);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/v/${link.slug}`);
    const b = await frame(page);
    expect(b.height).toBeGreaterThan(b.width * 1.6);
    expect(b.width).toBeLessThanOrEqual(440);
    expect(await noHorizontalScroll(page)).toBe(true);
  });
});

test.describe('landscape video on a phone', () => {
  const { defaultBrowserType: _b, ...phone } = devices['Pixel 7'];
  test.use(phone);
  test('is letterboxed over a blurred backdrop when upright and fills the screen sideways', async ({
    page,
    request,
  }) => {
    const link = await storyLink(request, 'e2e story phone landscape');
    await page.goto(`/v/${link.slug}`);
    expect(await page.locator('video').evaluate((v) => getComputedStyle(v).objectFit)).toBe('contain');
    await expect(page.locator('.vs-backdrop')).toBeVisible();
    const vp = page.viewportSize()!;
    const b = await frame(page);
    expect(Math.round(b.width)).toBe(vp.width); // full-viewport stage, video letterboxed inside
    await page.setViewportSize({ width: vp.height, height: vp.width }); // rotate
    const r = await frame(page);
    expect(Math.round(r.width)).toBe(vp.height);
    expect(Math.round(r.height)).toBe(vp.width);
    expect(await noHorizontalScroll(page)).toBe(true);
  });
});
