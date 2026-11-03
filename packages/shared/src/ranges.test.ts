import { describe, it, expect } from 'vitest';
import { unionRanges, rangesLength, coveredBuckets, bucketPlayCounts, clampRanges } from './ranges.js';
import { watchStats, retentionCurve, quartilesReached, percentile, dropOffPoints } from './metrics.js';

describe('unionRanges', () => {
  it('merges overlapping and touching ranges', () => {
    expect(
      unionRanges([
        [0, 10],
        [5, 20],
        [20, 30],
        [40, 50],
      ]),
    ).toEqual([
      [0, 30],
      [40, 50],
    ]);
  });
  it('drops invalid/empty ranges and sorts', () => {
    expect(
      unionRanges([
        [30, 40],
        [10, 10],
        [5, 1],
        [NaN, 3],
        [0, 5],
      ]),
    ).toEqual([
      [0, 5],
      [30, 40],
    ]);
  });
  it('handles backward seek (rewatch) without double counting', () => {
    // played 0..30s, sought back to 10s, played to 40s
    expect(
      rangesLength([
        [0, 30_000],
        [10_000, 40_000],
      ]),
    ).toBe(40_000);
  });
  it('handles 2x playback: wall time differs, media ranges are what count', () => {
    // at 2x, 10 s wall time covers 20 s of media
    expect(rangesLength([[0, 20_000]])).toBe(20_000);
  });
  it('clamps to duration', () => {
    expect(clampRanges([[0, 70_000]], 60_000)).toEqual([[0, 60_000]]);
  });
});

describe('buckets', () => {
  it('covers half of buckets for first-half playback', () => {
    const b = coveredBuckets([[0, 50_000]], 100_000, 100);
    expect(b.filter(Boolean).length).toBe(50);
    expect(b[49]).toBe(true);
    expect(b[50]).toBe(false);
  });
  it('counts rewatches per bucket from raw ranges', () => {
    const c = bucketPlayCounts(
      [
        [0, 50_000],
        [0, 10_000],
      ],
      100_000,
      10,
    );
    expect(c.slice(0, 5)).toEqual([2, 1, 1, 1, 1]);
    expect(c[5]).toBe(0);
  });
});

describe('metrics', () => {
  it('scenario: play 0-30 %, seek to 60 %, play to 70 %', () => {
    const d = 100_000;
    const s = watchStats(
      [
        [0, 30_000],
        [60_000, 70_000],
      ],
      d,
    );
    expect(s.uniqueWatchedMs).toBe(40_000);
    expect(s.maxPositionMs).toBe(70_000);
    expect(s.quartiles).toEqual([25]);
    expect(s.isView).toBe(true);
    expect(s.isCompletion).toBe(false);
  });
  it('short play is not a view', () => {
    expect(watchStats([[0, 1500]], 60_000).isView).toBe(false);
  });
  it('completion at 95 %', () => {
    expect(watchStats([[0, 95_000]], 100_000).isCompletion).toBe(true);
    expect(quartilesReached(95)).toEqual([25, 50, 75, 100]);
  });
  it('interrupted session (vertical video duration irrelevant to math)', () => {
    const s = watchStats([[0, 7_000]], 28_000);
    expect(s.completionPct).toBe(25);
    expect(s.quartiles).toEqual([25]);
  });
  it('retention curve ignores non-views', () => {
    const curve = retentionCurve([[[0, 100_000]], [[0, 50_000]], [[0, 1000]]], 100_000, 10);
    expect(curve[0]).toBe(1);
    expect(curve[9]).toBe(0.5);
    const drops = dropOffPoints(curve, 100_000, 1);
    expect(drops[0]?.bucket).toBe(5);
  });
  it('percentile', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 50)).toBeNull();
  });
});
