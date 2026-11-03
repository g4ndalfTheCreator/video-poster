/** Half-open interval [from, to) in milliseconds. */
export type Range = readonly [number, number];

/** Normalises ranges: drops empty/invalid ones, sorts and merges overlapping or touching ranges. */
export function unionRanges(ranges: readonly Range[], mergeGapMs = 0): Range[] {
  const valid = ranges
    .filter((r) => Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] > r[0])
    .map((r) => [Math.max(0, r[0]), r[1]] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const r of valid) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + mergeGapMs) {
      last[1] = Math.max(last[1], r[1]);
    } else {
      out.push([r[0], r[1]]);
    }
  }
  return out;
}

export function rangesLength(ranges: readonly Range[]): number {
  return unionRanges(ranges).reduce((sum, r) => sum + (r[1] - r[0]), 0);
}

export function clampRanges(ranges: readonly Range[], durationMs: number): Range[] {
  return unionRanges(ranges.map((r) => [Math.min(r[0], durationMs), Math.min(r[1], durationMs)] as Range));
}

export function maxEnd(ranges: readonly Range[]): number {
  return ranges.reduce((m, r) => Math.max(m, r[1]), 0);
}

/**
 * Returns which of `buckets` equal-width buckets are covered by the ranges.
 * A bucket counts as covered when at least `minCoverage` (0..1) of it is played.
 */
export function coveredBuckets(
  ranges: readonly Range[],
  durationMs: number,
  buckets = 100,
  minCoverage = 0.5,
): boolean[] {
  const result = new Array<boolean>(buckets).fill(false);
  if (durationMs <= 0) return result;
  const width = durationMs / buckets;
  const merged = clampRanges(ranges, durationMs);
  for (let b = 0; b < buckets; b++) {
    const start = b * width;
    const end = start + width;
    let covered = 0;
    for (const r of merged) {
      if (r[1] <= start) continue;
      if (r[0] >= end) break;
      covered += Math.min(end, r[1]) - Math.max(start, r[0]);
    }
    result[b] = covered >= width * minCoverage;
  }
  return result;
}

/**
 * Counts how many times each bucket was played given a list of raw (non-merged) play ranges,
 * e.g. heartbeat deltas. Used for the rewatch heatmap.
 */
export function bucketPlayCounts(rawRanges: readonly Range[], durationMs: number, buckets = 100): number[] {
  const counts = new Array<number>(buckets).fill(0);
  if (durationMs <= 0) return counts;
  const width = durationMs / buckets;
  // Accumulate coverage in ms per bucket, then divide by width.
  const coverage = new Array<number>(buckets).fill(0);
  for (const r of rawRanges) {
    const from = Math.max(0, Math.min(r[0], durationMs));
    const to = Math.max(0, Math.min(r[1], durationMs));
    if (to <= from) continue;
    const first = Math.floor(from / width);
    const last = Math.min(buckets - 1, Math.floor((to - 1) / width));
    for (let b = first; b <= last; b++) {
      const s = b * width;
      coverage[b]! += Math.min(to, s + width) - Math.max(from, s);
    }
  }
  for (let b = 0; b < buckets; b++) counts[b] = Math.round(coverage[b]! / width);
  return counts;
}

/** Parses a ranges JSON value defensively. */
export function parseRanges(value: unknown): Range[] {
  if (!Array.isArray(value)) return [];
  const out: Range[] = [];
  for (const r of value) {
    if (Array.isArray(r) && r.length === 2 && typeof r[0] === 'number' && typeof r[1] === 'number') {
      out.push([r[0], r[1]]);
    }
  }
  return out;
}
