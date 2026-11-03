import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import nacl from 'tweetnacl';

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacBase64Url(key: string, data: string): string {
  return createHmac('sha256', key).update(data).digest('base64url');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** libsodium-compatible secretbox (XSalsa20-Poly1305). Output: base64(nonce || box). */
export function encryptJson(keyHex: string, value: unknown): string {
  const key = Buffer.from(keyHex, 'hex');
  const nonce = randomBytes(nacl.secretbox.nonceLength);
  const box = nacl.secretbox(Buffer.from(JSON.stringify(value)), nonce, key);
  return Buffer.concat([nonce, Buffer.from(box)]).toString('base64');
}

export function decryptJson<T = unknown>(keyHex: string, sealed: string): T {
  const key = Buffer.from(keyHex, 'hex');
  const raw = Buffer.from(sealed, 'base64');
  const nonce = raw.subarray(0, nacl.secretbox.nonceLength);
  const box = raw.subarray(nacl.secretbox.nonceLength);
  const opened = nacl.secretbox.open(box, nonce, key);
  if (!opened) throw new Error('decryption failed');
  return JSON.parse(Buffer.from(opened).toString('utf8')) as T;
}

/** Signed, expiring token: base64url(json).hmac */
export function signToken(key: string, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmacBase64Url(key, body)}`;
}

export function verifyToken<T extends { exp: number }>(
  key: string,
  token: string,
  nowSec = Date.now() / 1000,
): T | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sig, hmacBase64Url(key, body))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
    if (typeof payload.exp !== 'number' || payload.exp < nowSec) return null;
    return payload;
  } catch {
    return null;
  }
}
