import { describe, it, expect } from 'vitest';
import { generateSlug, checkCustomSlug, suggestSlug, ANY_SLUG_RE } from './slug.js';
import { clientEventSchema } from './events.js';

describe('slugs', () => {
  it('generates 12-char base62 slugs', () => {
    const s = generateSlug();
    expect(s).toMatch(/^[0-9A-Za-z]{12}$/);
    expect(ANY_SLUG_RE.test(s)).toBe(true);
    expect(new Set(Array.from({ length: 1000 }, () => generateSlug())).size).toBe(1000);
  });
  it('validates custom slugs', () => {
    expect(checkCustomSlug('ab')).toEqual({ ok: false, reason: 'format' });
    expect(checkCustomSlug('-abc')).toEqual({ ok: false, reason: 'format' });
    expect(checkCustomSlug('admin')).toEqual({ ok: false, reason: 'reserved' });
    expect(checkCustomSlug('Upper')).toEqual({ ok: false, reason: 'format' });
    expect(checkCustomSlug('whale')).toEqual({ ok: true, guessable: true });
    expect(checkCustomSlug('whale-cv')).toEqual({ ok: true, guessable: true });
    expect(checkCustomSlug('whale-cv-k3x9q7z2m4')).toMatchObject({ ok: true, guessable: false });
  });
  it('suggests a suffixed slug', () => {
    expect(suggestSlug('Whale CV')).toMatch(/^whale-cv-[a-z0-9]{4}$/);
    expect(suggestSlug('Äiti')).toMatch(/^aiti-[a-z0-9]{4}$/);
  });
});

describe('event schema', () => {
  it('accepts heartbeat and drops unknown fields', () => {
    const r = clientEventSchema.parse({
      seq: 1,
      type: 'heartbeat',
      client_ts: 1,
      position_ms: 5000,
      payload: { played_delta: [[0, 5000]], evil: 'x' },
    });
    expect(r.payload).toEqual({ played_delta: [[0, 5000]] });
  });
  it('truncates long strings', () => {
    const r = clientEventSchema.parse({
      seq: 1,
      type: 'error',
      client_ts: 1,
      payload: { message: 'x'.repeat(500) },
    });
    expect((r.payload.message as string).length).toBe(200);
  });
  it('rejects invalid payloads and unknown types', () => {
    expect(clientEventSchema.safeParse({ seq: 1, type: 'seek', client_ts: 1, payload: {} }).success).toBe(
      false,
    );
    expect(clientEventSchema.safeParse({ seq: 1, type: 'password_ok', client_ts: 1 }).success).toBe(false);
  });
});
