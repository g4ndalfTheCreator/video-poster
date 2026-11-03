/** Thin fetch wrapper for /api/admin. Adds the CSRF header and normalises errors. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;
export const setCsrf = (t: string | null) => {
  csrfToken = t;
};

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const method = (init.method ?? 'GET').toUpperCase();
  if (init.json !== undefined) headers.set('content-type', 'application/json');
  if (method !== 'GET' && csrfToken) headers.set('x-csrf-token', csrfToken);
  const res = await fetch(`/api/admin${path}`, {
    ...init,
    method,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    credentials: 'same-origin',
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = (body as { error?: { code: string; message: string; details?: unknown } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? res.statusText, err?.details);
  }
  return body as T;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, json?: unknown) => api<T>(path, { method: 'POST', json: json ?? {} });
export const patch = <T>(path: string, json: unknown) => api<T>(path, { method: 'PATCH', json });
export const put = <T>(path: string, json: unknown) => api<T>(path, { method: 'PUT', json });
export const del = <T>(path: string, json?: unknown) =>
  api<T>(path, { method: 'DELETE', ...(json ? { json } : {}) });

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}
