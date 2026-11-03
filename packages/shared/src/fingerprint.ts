/**
 * Browser-profile helpers shared by the SDK (collection) and the server (hashing, matching).
 * Volatile signals (viewport, network, storage quota) are excluded from the stable hash.
 */
export const VOLATILE_SIGNALS = new Set([
  'viewport',
  'connection',
  'storageQuota',
  'battery',
  'permissions',
  'ts',
]);
/** Signals that privacy browsers randomise per session; excluded from the "stable" hash when randomised. */
export const RANDOMIZABLE_SIGNALS = new Set([
  'canvas',
  'audio',
  'webglParams',
  'webglExt',
  'fonts',
  'voices',
]);

/** Signal groups and weights used for fuzzy matching (sum = 1). */
export const SIGNAL_GROUPS: Record<string, { keys: string[]; weight: number }> = {
  navigator: {
    keys: ['ua', 'platform', 'languages', 'hc', 'dm', 'tp', 'uach', 'pdf', 'cookies'],
    weight: 0.2,
  },
  screen: { keys: ['screen', 'dpr', 'colorDepth', 'media'], weight: 0.15 },
  locale: { keys: ['tz', 'tzOffset', 'locale', 'intl'], weight: 0.1 },
  graphics: {
    keys: ['webglVendor', 'webglRenderer', 'webglParams', 'webglExt', 'canvas', 'gpu'],
    weight: 0.25,
  },
  audio: { keys: ['audio', 'sampleRate', 'channels'], weight: 0.1 },
  fonts: { keys: ['fonts'], weight: 0.1 },
  media: { keys: ['codecs', 'mediaDevices', 'voices', 'features'], weight: 0.1 },
};

/** Deterministic JSON with sorted keys. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export function stableSubset(signals: Record<string, unknown>, randomized: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(signals)) {
    if (VOLATILE_SIGNALS.has(k)) continue;
    if (randomized && RANDOMIZABLE_SIGNALS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Weighted similarity of two signal sets in [0, 1], ignoring signals missing on either side. */
export function signalSimilarity(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  ignore: ReadonlySet<string> = VOLATILE_SIGNALS,
): number {
  let total = 0;
  let score = 0;
  for (const g of Object.values(SIGNAL_GROUPS)) {
    const keys = g.keys.filter((k) => !ignore.has(k) && a[k] !== undefined && b[k] !== undefined);
    if (!keys.length) continue;
    const same = keys.filter((k) => canonicalJson(a[k]) === canonicalJson(b[k])).length;
    total += g.weight;
    score += g.weight * (same / keys.length);
  }
  return total ? score / total : 0;
}
