import { test, expect } from '@playwright/test';
import { cli, uniqueEmail, totpAt, currentStep, nextCode } from './support.js';

test('editor logs in, enrolls TOTP and logs in again with TOTP', async ({ page }) => {
  const email = uniqueEmail('editor');
  const password = 'e2e password 1234';
  cli(['create-user', email, 'editor'], { VS_PASSWORD: password });

  await page.goto('/admin/');
  await page.getByLabel(/Sähköposti|Email/).fill(email);
  await page.getByLabel(/Salasana|Password/).fill(password);
  await page.getByRole('button', { name: /Kirjaudu|Sign in/ }).click();

  // TOTP enrollment is mandatory for editors
  const secretEl = page.getByTestId('totp-secret');
  await expect(secretEl).toBeVisible();
  const secret = (await secretEl.textContent())!.trim();
  await page.getByLabel(/Koodi|Code/).fill(totpAt(secret, currentStep()));
  await page.getByRole('button', { name: /Vahvista|Verify/ }).click();
  await expect(page.getByRole('link', { name: /Kojelauta|Dashboard/ })).toBeVisible();

  // log out and back in: second factor is asked
  await page.getByRole('button', { name: /Kirjaudu ulos|Log out/ }).click();
  await page.getByLabel(/Sähköposti|Email/).fill(email);
  await page.getByLabel(/Salasana|Password/).fill(password);
  await page.getByRole('button', { name: /Kirjaudu|Sign in/ }).click();
  await expect(page.getByText(/6-numeroinen|6-digit/)).toBeVisible();
  await page.getByLabel(/Koodi|Code/).fill('000000');
  await page.getByRole('button', { name: /Vahvista|Verify/ }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel(/Koodi|Code/).fill(nextCode(secret));
  await page.getByRole('button', { name: /Vahvista|Verify/ }).click();
  await expect(page.getByRole('link', { name: /Kojelauta|Dashboard/ })).toBeVisible();
});

test('viewer cannot mutate anything', async ({ page, request }) => {
  const email = uniqueEmail('viewer');
  const password = 'e2e password 1234';
  cli(['create-user', email, 'viewer'], { VS_PASSWORD: password });
  const login = await request.post('/api/admin/auth/login', { data: { email, password } });
  expect(login.ok()).toBeTruthy();
  const { csrfToken } = await login.json();
  const res = await request.put('/api/admin/settings', {
    data: { telemetry: { level: 'server' } },
    headers: { 'x-csrf-token': csrfToken },
  });
  expect(res.status()).toBe(403);
  void page;
});
