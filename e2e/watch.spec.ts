import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { adminSession } from './admin.js';
import { e2eState } from './global-setup.js';

function envValue(key: string): string {
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync('deploy/.env', 'utf8'));
  return process.env[key] ?? m?.[1] ?? '';
}

async function createLink(
  request: import('@playwright/test').APIRequestContext,
  body: Record<string, unknown>,
) {
  const s = await adminSession(request);
  const r = await request.post(`/api/admin/videos/${e2eState().videoId}/links`, {
    headers: s.headers,
    data: body,
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  return (await r.json()) as { slug: string; id: string; url: string };
}

test('viewer plays the video through a link', async ({ page, request }) => {
  const link = await createLink(request, { label: 'e2e playback', recipientName: 'Tester' });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const external: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (
      !['127.0.0.1', 'localhost'].includes(u.hostname) &&
      !u.protocol.startsWith('data') &&
      !u.protocol.startsWith('blob')
    )
      external.push(r.url());
  });
  await page.goto(`/v/${link.slug}`);
  await expect(page.locator('h1')).toHaveText('E2E sample');
  await page.locator('.vs-big').click();
  await expect
    .poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 30_000 })
    .toBeGreaterThan(2);
  // keyboard: pause with space
  await page.locator('.vs-player').focus();
  await page.keyboard.press(' ');
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test('unknown and expired links give an identical 404', async ({ request }) => {
  const expired = await createLink(request, {
    label: 'e2e expired',
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const a = await request.get(`/v/${expired.slug}`);
  const b = await request.get('/v/NoSuchLink123');
  expect(a.status()).toBe(404);
  expect(b.status()).toBe(404);
  expect(await a.text()).toBe(await b.text());
});

test('media URLs need a valid, unexpired token', async ({ request }) => {
  const link = await createLink(request, { label: 'e2e media' });
  const html = await (
    await request.get(`/v/${link.slug}`, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
      },
    })
  ).text();
  const cfg = JSON.parse(/id="vs-config">(.*?)<\/script>/s.exec(html)![1]!);
  expect((await request.get(cfg.master)).status()).toBe(200);
  const [, , , , sess, vid, ver] = (cfg.master as string).split('/');
  // no token
  expect((await request.get(`/media/${vid}/${ver}/master.m3u8`)).status()).toBe(403);
  // expired but correctly signed token
  const exp = Math.floor(Date.now() / 1000) - 10;
  const token = createHash('md5')
    .update(`${exp}${sess}${vid}${ver} ${envValue('MEDIA_SIGNING_KEY')}`)
    .digest('base64url');
  expect((await request.get(`/media/${token}/${exp}/${sess}/${vid}/${ver}/master.m3u8`)).status()).toBe(403);
  // same token, fresh expiry → valid signature check
  const exp2 = Math.floor(Date.now() / 1000) + 600;
  const token2 = createHash('md5')
    .update(`${exp2}${sess}${vid}${ver} ${envValue('MEDIA_SIGNING_KEY')}`)
    .digest('base64url');
  expect((await request.get(`/media/${token2}/${exp2}/${sess}/${vid}/${ver}/master.m3u8`)).status()).toBe(
    200,
  );
});

test('security headers on the watch page, 404 and admin SPA', async ({ request }) => {
  const link = await createLink(request, { label: 'e2e headers' });
  for (const url of [`/v/${link.slug}`, '/v/doesnotexist1', '/admin/', '/privacy']) {
    const h = (await request.get(url)).headers();
    for (const k of [
      'content-security-policy',
      'x-content-type-options',
      'referrer-policy',
      'permissions-policy',
    ])
      expect(h[k], `${url} ${k}`).toBeTruthy();
    expect(
      h['x-frame-options'] ??
        (h['content-security-policy']!.includes("frame-ancestors 'none'") ? 'csp' : undefined),
      url,
    ).toBeTruthy();
    expect(h['server'] ?? '').not.toMatch(/\d/); // no version disclosure
  }
});
