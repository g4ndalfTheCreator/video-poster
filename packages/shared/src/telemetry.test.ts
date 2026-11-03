import { describe, it, expect } from 'vitest';
import { estimateFromSegments, parseSegmentFile } from './estimate.js';
import { applyEvents, emptySummary } from './summary.js';
import { signalSimilarity, stableSubset, canonicalJson } from './fingerprint.js';

/** Simulates hls.js (maxBufferLength 10 s, 4 s segments) playing from `from` to `to` seconds. */
function simulateHlsJs(fromS: number, toS: number, t0: number, seg = 4, buffer = 10) {
  const fetches: { ts: number; index: number }[] = [];
  let next = Math.floor(fromS / seg);
  for (let pos = fromS; pos <= toS; pos += 0.25) {
    while (next * seg - pos < buffer && next * seg < 30) {
      fetches.push({ ts: t0 + (pos - fromS) * 1000, index: next });
      next++;
    }
  }
  return fetches;
}

describe('server-side estimate from segment fetches', () => {
  it('playback 0–50 % of a 30 s video is estimated within ±8 s', () => {
    const e = estimateFromSegments(simulateHlsJs(0, 15, 1_000_000), 30_000);
    expect(Math.abs(e.uniqueWatchedMs - 15_000)).toBeLessThanOrEqual(8_000);
    expect(e.fetchedOnly.length).toBe(1);
  });
  it('detects a seek as a new run and caps by wall-clock time', () => {
    const a = simulateHlsJs(0, 9, 0);
    const b = simulateHlsJs(18, 21, 9_500);
    const e = estimateFromSegments([...a, ...b], 30_000);
    expect(e.raw.length).toBe(2);
    expect(e.played[0]![0]).toBe(0);
    expect(e.played[0]![1]).toBeLessThanOrEqual(9_500);
    expect(e.played[1]![0]).toBe(16_000);
  });
  it('full playback counts to the end', () => {
    const e = estimateFromSegments(simulateHlsJs(0, 30, 0), 30_000);
    expect(e.uniqueWatchedMs).toBe(30_000);
  });
  it('treats an ABR re-fetch of the same segment as the same run', () => {
    const e = estimateFromSegments(
      [
        { ts: 0, index: 0 },
        { ts: 100, index: 1 },
        { ts: 200, index: 2 },
        { ts: 1500, index: 2, rendition: 1080 },
        { ts: 2100, index: 3 },
      ],
      60_000,
    );
    expect(e.raw.length).toBe(1);
  });
  it('parses segment names', () => {
    expect(parseSegmentFile('720p_00012.m4s')).toEqual({ rendition: 720, index: 12 });
    expect(parseSegmentFile('master.m3u8')).toBeNull();
  });
});

describe('summary reducer', () => {
  it('scenario: 0–30 %, seek to 60 %, play to 70 % of 30 s', () => {
    const s = applyEvents(
      emptySummary(),
      [
        { type: 'player_ready', position_ms: 0, payload: { startup_ms: 420 } },
        { type: 'play', position_ms: 0, payload: { source: 'user' } },
        { type: 'heartbeat', position_ms: 5000, payload: { played_delta: [[0, 5000]], rendition: 720 } },
        { type: 'heartbeat', position_ms: 9000, payload: { played_delta: [[5000, 9000]], rendition: 720 } },
        { type: 'seek', position_ms: 18000, payload: { from_ms: 9000, to_ms: 18000 } },
        {
          type: 'heartbeat',
          position_ms: 21000,
          payload: { played_delta: [[18000, 21000]], rendition: 1080 },
        },
        { type: 'session_end', position_ms: 21000, payload: { exit_reason: 'closed' } },
      ],
      30_000,
    );
    expect(s.uniqueWatchedMs).toBe(12_000);
    expect(s.maxPositionMs).toBe(21_000);
    expect(s.quartiles).toEqual([25]);
    expect(s.seekCount).toBe(1);
    expect(s.playCount).toBe(1);
    expect(s.startupMs).toBe(420);
    expect(s.renditions).toEqual({ '720': 9000, '1080': 3000 });
    expect(s.exitReason).toBe('closed');
  });
  it('counts rewatched time in watch_ms but not in unique', () => {
    const s = applyEvents(
      emptySummary(),
      [
        {
          type: 'heartbeat',
          position_ms: 0,
          payload: {
            played_delta: [
              [0, 10_000],
              [0, 10_000],
            ],
          },
        },
      ],
      20_000,
    );
    expect(s.watchMs).toBe(20_000);
    expect(s.uniqueWatchedMs).toBe(10_000);
    expect(s.rawRanges.length).toBe(2);
  });
  it('is incremental across batches', () => {
    const a = applyEvents(
      emptySummary(),
      [{ type: 'heartbeat', position_ms: 0, payload: { played_delta: [[0, 5000]] } }],
      10_000,
    );
    const b = applyEvents(
      a,
      [
        { type: 'heartbeat', position_ms: 0, payload: { played_delta: [[5000, 10_000]] } },
        { type: 'ended', position_ms: 10_000, payload: {} },
      ],
      10_000,
    );
    expect(b.completionPct).toBe(100);
    expect(b.quartiles).toEqual([25, 50, 75, 100]);
    expect(b.ended).toBe(true);
  });
});

describe('fingerprint helpers', () => {
  const base = {
    ua: 'x',
    platform: 'Linux',
    tz: 'Europe/Helsinki',
    canvas: 'abc',
    fonts: ['Arial'],
    webglRenderer: 'Mesa',
    viewport: [100, 100],
  };
  it('canonical json sorts keys', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });
  it('stable subset drops volatile and (when randomised) randomisable signals', () => {
    expect(Object.keys(stableSubset(base, false))).not.toContain('viewport');
    expect(Object.keys(stableSubset(base, true))).not.toContain('canvas');
  });
  it('similarity', () => {
    expect(signalSimilarity(base, { ...base, viewport: [1, 1] })).toBe(1);
    expect(signalSimilarity(base, { ...base, canvas: 'zzz' })).toBeLessThan(1);
    expect(signalSimilarity(base, { ...base, canvas: 'zzz' })).toBeGreaterThan(0.8);
  });
});
