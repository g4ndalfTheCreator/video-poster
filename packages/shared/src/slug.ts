import { RESERVED_SLUGS } from './constants.js';

const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER36 = '0123456789abcdefghijklmnopqrstuvwxyz';

export const CUSTOM_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{2,62}[a-z0-9])$/;
/** Generated slugs are 12 chars base62; accepted by the router as well. */
export const ANY_SLUG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{2,62}[A-Za-z0-9])$/;

function randomChars(alphabet: string, length: number): string {
  // Rejection sampling to avoid modulo bias.
  const out: string[] = [];
  const max = Math.floor(256 / alphabet.length) * alphabet.length;
  while (out.length < length) {
    const buf = new Uint8Array(length * 2);
    globalThis.crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < max && out.length < length) out.push(alphabet[b % alphabet.length]!);
    }
  }
  return out.join('');
}

/** Random 12-character base62 slug (~71 bits of entropy). */
export function generateSlug(length = 12): string {
  return randomChars(BASE62, length);
}

export function randomSuffix(length = 4): string {
  return randomChars(LOWER36, length);
}

export type SlugCheck = { ok: true; guessable: boolean } | { ok: false; reason: 'format' | 'reserved' };

/**
 * Validates a custom slug. `guessable` is a heuristic warning: slugs with fewer than
 * ~40 bits of estimated entropy (e.g. a plain name) are flagged and the UI suggests a suffix.
 */
export function checkCustomSlug(slug: string): SlugCheck {
  if (!CUSTOM_SLUG_RE.test(slug)) return { ok: false, reason: 'format' };
  if (RESERVED_SLUGS.has(slug)) return { ok: false, reason: 'reserved' };
  return { ok: true, guessable: estimateEntropyBits(slug) < 40 };
}

/** Very rough entropy estimate: dictionary-ish words count little, random alnum runs count more. */
export function estimateEntropyBits(slug: string): number {
  let bits = 0;
  for (const part of slug.split('-')) {
    if (!part) continue;
    const digits = (part.match(/[0-9]/g) ?? []).length;
    const letters = part.length - digits;
    const hasVowelPattern = /[aeiouy]/.test(part) && /^[a-z]+$/.test(part);
    if (hasVowelPattern && part.length >= 3) {
      // Looks like a word: ~11 bits per word regardless of length.
      bits += 11;
    } else {
      bits += letters * Math.log2(36) + digits * Math.log2(10);
    }
  }
  return bits;
}

/** Suggests a less guessable variant, e.g. `whale-cv` → `whale-cv-k3x9`. */
export function suggestSlug(base: string): string {
  const cleaned = base
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  const candidate = `${cleaned || 'v'}-${randomSuffix(4)}`;
  return candidate.length >= 4 ? candidate : `${candidate}${randomSuffix(4)}`;
}
