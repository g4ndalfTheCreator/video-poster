import { COMPLETION_THRESHOLD_PCT, VIEW_MIN_WATCHED_MS } from './constants.js';
import { coveredBuckets, rangesLength, clampRanges, maxEnd, type Range } from './ranges.js';

export interface WatchStats {
  uniqueWatchedMs: number;
  maxPositionMs: number;
  completionPct: number;
  isView: boolean;
  isCompletion: boolean;
  quartiles: number[];
}

/** Quartiles reached by unique content watched (25/50/75/100). 100 is reached at >= 95 %. */
export function quartilesReached(completionPct: number): number[] {
  const q: number[] = [];
  if (completionPct >= 25) q.push(25);
  if (completionPct >= 50) q.push(50);
  if (completionPct >= 75) q.push(75);
  if (completionPct >= COMPLETION_THRESHOLD_PCT) q.push(100);
  return q;
}

export function watchStats(ranges: readonly Range[], durationMs: number): WatchStats {
  const clamped = clampRanges(ranges, durationMs);
  const uniqueWatchedMs = rangesLength(clamped);
  const completionPct = durationMs > 0 ? Math.min(100, (uniqueWatchedMs / durationMs) * 100) : 0;
  return {
    uniqueWatchedMs,
    maxPositionMs: maxEnd(clamped),
    completionPct: Math.round(completionPct * 100) / 100,
    isView: uniqueWatchedMs >= VIEW_MIN_WATCHED_MS,
    isCompletion: uniqueWatchedMs >= VIEW_MIN_WATCHED_MS && completionPct >= COMPLETION_THRESHOLD_PCT,
    quartiles: quartilesReached(completionPct),
  };
}

/**
 * Retention curve: for each bucket, the share of views whose played ranges cover it.
 * `sessions` are the played_ranges of each view.
 */
export function retentionCurve(
  sessions: readonly (readonly Range[])[],
  durationMs: number,
  buckets = 100,
): number[] {
  const counts = new Array<number>(buckets).fill(0);
  let views = 0;
  for (const ranges of sessions) {
    if (rangesLength(ranges) < VIEW_MIN_WATCHED_MS) continue;
    views++;
    coveredBuckets(ranges, durationMs, buckets).forEach((c, i) => {
      if (c) counts[i]!++;
    });
  }
  return counts.map((c) => (views ? c / views : 0));
}

/** Largest drop-offs between consecutive retention buckets. */
export function dropOffPoints(curve: readonly number[], durationMs: number, top = 5) {
  const drops = [] as { bucket: number; positionMs: number; drop: number }[];
  for (let i = 1; i < curve.length; i++) {
    const drop = curve[i - 1]! - curve[i]!;
    if (drop > 0) drops.push({ bucket: i, positionMs: Math.round((i / curve.length) * durationMs), drop });
  }
  return drops.sort((a, b) => b.drop - a.drop).slice(0, top);
}

export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export function rebufferRatio(rebufferMs: number, watchMs: number): number {
  const denom = watchMs + rebufferMs;
  return denom > 0 ? rebufferMs / denom : 0;
}
