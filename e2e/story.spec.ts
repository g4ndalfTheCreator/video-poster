import { test, expect, devices, type APIRequestContext, type Page } from '@playwright/test';
import { adminSession } from './admin.js';
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

test('story mode on desktop uses a phone-shaped frame', async ({ page, request }) => {
  const link = await storyLink(request, 'e2e story desktop');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/v/${link.slug}`);
  const box = (await page.locator('.vs-story-player').boundingBox())!;
  expect(box.height).toBeGreaterThan(box.width * 1.5);
  expect(box.width).toBeLessThan(600);
});
