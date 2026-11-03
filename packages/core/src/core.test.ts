import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from './config.js';
import { encryptJson, decryptJson, signToken, verifyToken } from './crypto.js';
import { truncateIp, isLanIp, resolveClientIp, ipInCidrs } from './ip.js';
import { maskUrl } from './logger.js';

describe('config', () => {
  it('fails with a clear message listing missing values', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({});
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('PUBLIC_HOST');
      expect(msg).toContain('DATABASE_URL');
      expect(msg).toContain('MEDIA_SIGNING_KEY');
      expect(msg).toContain('APP_ENCRYPTION_KEY');
    }
  });
});

describe('crypto', () => {
  it('secretbox round-trip', () => {
    const key = 'ab'.repeat(32);
    const sealed = encryptJson(key, { a: 1 });
    expect(decryptJson(key, sealed)).toEqual({ a: 1 });
    expect(() => decryptJson('cd'.repeat(32), sealed)).toThrow();
  });
  it('signed tokens expire and resist tampering', () => {
    const t = signToken('k'.repeat(32), { s: 'x', exp: 2000 });
    expect(verifyToken('k'.repeat(32), t, 1000)).toEqual({ s: 'x', exp: 2000 });
    expect(verifyToken('k'.repeat(32), t, 3000)).toBeNull();
    expect(verifyToken('k'.repeat(32), t.replace(/^./, 'A'), 1000)).toBeNull();
  });
});

describe('ip', () => {
  it('truncates', () => {
    expect(truncateIp('203.0.113.77')).toBe('203.0.113.0/24');
    expect(truncateIp('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48');
    expect(truncateIp('::ffff:198.51.100.4')).toBe('198.51.100.0/24');
  });
  it('detects LAN ranges', () => {
    for (const ip of [
      '10.1.2.3',
      '192.168.1.1',
      '172.20.0.1',
      '100.64.1.1',
      '127.0.0.1',
      '::1',
      'fd00::1',
      'fe80::1',
    ]) {
      expect(isLanIp(ip)).toBe(true);
    }
    expect(isLanIp('8.8.8.8')).toBe(false);
  });
  it('resolves XFF only via trusted proxies', () => {
    expect(resolveClientIp('172.18.0.2', '1.2.3.4', ['172.16.0.0/12'])).toBe('1.2.3.4');
    expect(resolveClientIp('5.6.7.8', '1.2.3.4', ['172.16.0.0/12'])).toBe('5.6.7.8');
    expect(resolveClientIp('172.18.0.2', '9.9.9.9, 1.2.3.4', ['172.16.0.0/12'])).toBe('1.2.3.4');
    expect(ipInCidrs('::ffff:10.0.0.1', ['10.0.0.0/8'])).toBe(true);
  });
  it('masks tokens in urls', () => {
    expect(maskUrl('/media/abc/1234/x?st=secret')).toBe('/media/***/x?st=***');
  });
});
