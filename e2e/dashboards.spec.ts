import { test, expect } from '@playwright/test';
import { adminSession } from './admin.js';

test('admin dashboards render without errors', async ({ page }) => {
  await adminSession(page.request);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on(
    'response',
    (r) => r.url().includes('/api/admin/') && r.status() >= 500 && errors.push(`${r.status()} ${r.url()}`),
  );
  for (const [path, heading] of [
    ['/admin/', /Kojelauta|Dashboard/],
    ['/admin/analytics', /Analytiikka|Analytics/],
    ['/admin/analytics?view=quality', /Analytiikka|Analytics/],
    ['/admin/sessions', /Istunnot|Sessions/],
    ['/admin/visitors', /Katsojat|Viewers/],
    ['/admin/videos', /Videot|Videos/],
    ['/admin/system', /Järjestelmä|System/],
    ['/admin/settings?tab=channels', /Asetukset|Settings/],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
    await page.waitForLoadState('networkidle').catch(() => undefined);
  }
  expect(errors).toEqual([]);
});
