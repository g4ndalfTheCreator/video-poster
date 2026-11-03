import { HLS_SEGMENT_SECONDS, PLAYER_MAX_BUFFER_SECONDS } from './constants.js';
import { unionRanges, type Range } from './ranges.js';

export interface SegmentFetch {
  /** epoch ms */
  ts: number;
  index: number;
  rendition?: number | null;
}

export interface ServerEstimate {
  /** Merged ranges estimated as watched. */
  played: Range[];
  /** Raw (possibly overlapping) runs, for rewatch counting. */
  raw: Range[];
  /** Fetched but not certainly watched (buffered ahead). */
  fetchedOnly: Range[];
  uniqueWatchedMs: number;
  watchMs: number;
  lastActivity: number | null;
}

/**
 * Estimates watched media time from HLS segment fetches alone (no client JS).
 *
 * Players keep about `bufferS` seconds buffered ahead: segment k is requested when the playhead is
 * roughly at `k·seg − buffer`. A run of consecutive segments a…b therefore means the viewer watched from
 * `a·seg` until somewhere in [b·seg − buffer, (b+1)·seg − buffer); we take the middle. A jump in segment
 * order starts a new run (seek). Position cannot advance faster than wall-clock time, so each run is
 * also capped by the time until the next run started. A run that reaches the last segment counts as
 * watched to the end when there was enough time for it.
 */
export function estimateFromSegments(
  fetches: readonly SegmentFetch[],
  durationMs: number,
  opts: { segmentS?: number; bufferS?: number; sessionEnd?: number | null } = {},
): ServerEstimate {
  const seg = (opts.segmentS ?? HLS_SEGMENT_SECONDS) * 1000;
  const buffer = (opts.bufferS ?? PLAYER_MAX_BUFFER_SECONDS) * 1000;
  const sorted = [...fetches].filter((f) => f.index >= 0).sort((a, b) => a.ts - b.ts);
  const runs: { first: number; last: number; t0: number; t1: number }[] = [];
  for (const f of sorted) {
    const r = runs[runs.length - 1];
    // Same index again within a few seconds = ABR re-fetch at another rendition, not a seek.
    if (
      r &&
      (f.index === r.last + 1 ||
        (f.index === r.last && f.ts - r.t1 < 3000) ||
        (f.index < r.last && f.index >= r.first && f.ts - r.t1 < 3000))
    ) {
      r.last = Math.max(r.last, f.index);
      r.t1 = f.ts;
    } else runs.push({ first: f.index, last: f.index, t0: f.ts, t1: f.ts });
  }
  const lastSeg = Math.max(0, Math.ceil(durationMs / seg) - 1);
  const raw: Range[] = [];
  const fetchedOnly: Range[] = [];
  runs.forEach((r, i) => {
    const start = r.first * seg;
    const fetchedEnd = Math.min((r.last + 1) * seg, durationMs);
    const nextStart = runs[i + 1]?.t0 ?? opts.sessionEnd ?? null;
    let end: number;
    if (r.last >= lastSeg) {
      end = durationMs;
    } else {
      end = Math.max(start, (r.last + 1) * seg - buffer - seg / 2);
    }
    if (nextStart !== null) end = Math.min(end, start + Math.max(0, nextStart - r.t0));
    end = Math.min(end, fetchedEnd);
    if (end > start) raw.push([start, end]);
    if (fetchedEnd > end) fetchedOnly.push([end, fetchedEnd]);
  });
  const played = unionRanges(raw);
  return {
    played,
    raw,
    fetchedOnly: unionRanges(fetchedOnly),
    uniqueWatchedMs: played.reduce((s, r) => s + r[1] - r[0], 0),
    watchMs: raw.reduce((s, r) => s + r[1] - r[0], 0),
    lastActivity: sorted.length ? sorted[sorted.length - 1]!.ts : null,
  };
}

/** Parses a segment file name like `720p_00012.m4s` → { rendition: 720, index: 12 }. */
export function parseSegmentFile(file: string): { rendition: number; index: number } | null {
  const m = /^(\d+)p_(\d+)\.m4s$/.exec(file);
  return m ? { rendition: Number(m[1]), index: Number(m[2]) } : null;
}
