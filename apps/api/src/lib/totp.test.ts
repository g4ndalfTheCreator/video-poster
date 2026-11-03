import { describe, it, expect } from 'vitest';
import { totpAt, base32Decode, base32Encode, verifyTotp } from './totp.js';

describe('totp', () => {
  it('matches RFC 6238 SHA-1 test vectors', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totpAt(secret, Math.floor(59 / 30))).toBe('287082');
    expect(totpAt(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(totpAt(secret, Math.floor(2000000000 / 30))).toBe('279037');
  });
  it('round-trips base32', () => {
    const b = Buffer.from([1, 2, 3, 250, 99]);
    expect(base32Decode(base32Encode(b))).toEqual(b);
  });
  it('accepts ±1 step and rejects replays', () => {
    const secret = base32Encode(Buffer.from('abcdefghijabcdefghij'));
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(secret, totpAt(secret, step - 1), null, now)).toBe(step - 1);
    expect(verifyTotp(secret, totpAt(secret, step + 2), null, now)).toBeNull();
    expect(verifyTotp(secret, totpAt(secret, step), step, now)).toBeNull();
  });
});
