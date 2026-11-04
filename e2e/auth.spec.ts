import { test, expect } from '@playwright/test';
import { cli, uniqueEmail, totpAt, currentStep, nextCode, psql } from './support.js';
import { adminSession } from './admin.js';

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

test('sensitive actions ask for the password and code again, then continue', async ({ page }) => {
  // the browser context shares cookies with page.request
  const s = await adminSession(page.request, 'owner');
  test.skip(
    psql(`UPDATE admin_sessions SET reauth_at = now() - interval '1 hour'
          WHERE user_id = (SELECT id FROM admin_users WHERE email = '${s.email}')`) === null,
    'needs the compose stack',
  );
  await page.goto('/admin/settings?tab=tokens');
  await page.getByPlaceholder(/Nimi|Name/).fill('grafana');
  await page.getByRole('button', { name: /Luo token|Create token/ }).click();

  const dialog = page.getByRole('dialog', { name: /Vahvista henkilöllisyys|Confirm it is you/ });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/Salasana|Password/).fill(s.password);
  await dialog.getByLabel(/Koodi|Code/).fill(nextCode(s.secret));
  await dialog.getByRole('button', { name: /Vahvista|Confirm/ }).click();
  await expect(dialog).toBeHidden();
  // the original request was retried after confirmation
  await expect(page.locator('code').filter({ hasText: /.{20,}/ })).toBeVisible();

  // own sessions are listed on the account tab
  await page.goto('/admin/settings?tab=account');
  await expect(page.getByText(/Tämä laite|This device/)).toBeVisible();
});
