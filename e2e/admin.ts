import { expect, type APIRequestContext } from '@playwright/test';
import { cli, uniqueEmail, totpAt, currentStep } from './support.js';

export interface AdminSession {
  email: string;
  password: string;
  secret: string;
  csrf: string;
  headers: Record<string, string>;
}

/** Creates an editor via the CLI, enrolls TOTP over the API and returns a full session in `request`. */
export async function adminSession(
  request: APIRequestContext,
  role: 'owner' | 'editor' = 'editor',
): Promise<AdminSession> {
  const email = uniqueEmail(role);
  const password = 'e2e password 1234';
  cli(['create-user', email, role], { VS_PASSWORD: password });
  const login = await request.post('/api/admin/auth/login', { data: { email, password } });
  expect(login.ok()).toBeTruthy();
  const csrf = (await login.json()).csrfToken as string;
  const headers = { 'x-csrf-token': csrf };
  const enroll = await request.post('/api/admin/auth/totp/enroll', { headers, data: {} });
  const { secret } = await enroll.json();
  const confirm = await request.post('/api/admin/auth/totp/enroll/confirm', {
    headers,
    data: { code: totpAt(secret, currentStep()) },
  });
  expect(confirm.ok()).toBeTruthy();
  return { email, password, secret, csrf, headers };
}

/** Uploads a file with the tus protocol in 8 MB chunks; returns the video id. */
export async function tusUpload(
  request: APIRequestContext,
  s: AdminSession,
  data: Buffer,
  filename: string,
  title: string,
): Promise<string> {
  const meta = `filename ${Buffer.from(filename).toString('base64')},title ${Buffer.from(title).toString('base64')}`;
  const create = await request.post('/api/admin/uploads', {
    headers: {
      ...s.headers,
      'tus-resumable': '1.0.0',
      'upload-length': String(data.length),
      'upload-metadata': meta,
    },
  });
  expect(create.status()).toBe(201);
  const location = create.headers()['location']!;
  let offset = 0;
  let videoId = '';
  while (offset < data.length) {
    const chunk = data.subarray(offset, offset + 8 * 1024 * 1024);
    const res = await request.patch(location, {
      headers: {
        ...s.headers,
        'tus-resumable': '1.0.0',
        'upload-offset': String(offset),
        'content-type': 'application/offset+octet-stream',
      },
      data: chunk,
    });
    expect(res.status()).toBe(204);
    offset = Number(res.headers()['upload-offset']);
    videoId = res.headers()['x-video-id'] ?? videoId;
  }
  return videoId;
}

export async function waitForVideo(
  request: APIRequestContext,
  id: string,
  status: string,
  timeoutMs = 180_000,
) {
  const started = Date.now();
  for (;;) {
    const v = await (await request.get(`/api/admin/videos/${id}`)).json();
    if (v.status === status || (v.status === 'failed' && status !== 'failed')) return v;
    if (Date.now() - started > timeoutMs) throw new Error(`video ${id} stuck in ${v.status}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
