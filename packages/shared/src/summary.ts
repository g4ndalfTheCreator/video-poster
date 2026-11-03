import { clampRanges, maxEnd, rangesLength, unionRanges, type Range } from './ranges.js';
import { quartilesReached } from './metrics.js';

/** Fields of session_summaries maintained from client events. */
export interface SummaryState {
  watchMs: number;
  uniqueWatchedMs: number;
  maxPositionMs: number;
  completionPct: number;
  playCount: number;
  seekCount: number;
  rebufferCount: number;
  rebufferMs: number;
  startupMs: number | null;
  ttffMs: number | null;
  qualitySwitches: number;
  ended: boolean;
  quartiles: number[];
  playedRanges: Range[];
  rawRanges: Range[];
  renditions: Record<string, number>;
  errors: number;
  exitReason: string | null;
}

export const emptySummary = (): SummaryState => ({
  watchMs: 0,
  uniqueWatchedMs: 0,
  maxPositionMs: 0,
  completionPct: 0,
  playCount: 0,
  seekCount: 0,
  rebufferCount: 0,
  rebufferMs: 0,
  startupMs: null,
  ttffMs: null,
  qualitySwitches: 0,
  ended: false,
  quartiles: [],
  playedRanges: [],
  rawRanges: [],
  renditions: {},
  errors: 0,
  exitReason: null,
});

export interface SummaryEvent {
  type: string;
  position_ms: number | null;
  payload: Record<string, unknown>;
}

const MAX_RAW_RANGES = 2000;

/** Applies validated client events to a summary (pure; server is the source of truth for derived values). */
export function applyEvents(
  prev: SummaryState,
  events: readonly SummaryEvent[],
  durationMs: number,
): SummaryState {
  const s: SummaryState = {
    ...prev,
    playedRanges: [...prev.playedRanges],
    rawRanges: [...prev.rawRanges],
    renditions: { ...prev.renditions },
  };
  const dur = durationMs > 0 ? durationMs : Number.MAX_SAFE_INTEGER;
  for (const e of events) {
    const p = e.payload;
    switch (e.type) {
      case 'heartbeat': {
        // Clamp individually (no union): repeated ranges are rewatches and count in watch_ms.
        const deltas = ((p.played_delta as Range[] | undefined) ?? [])
          .map((r) => [Math.max(0, Math.min(r[0], dur)), Math.max(0, Math.min(r[1], dur))] as Range)
          .filter((r) => r[1] > r[0]);
        for (const d of deltas) {
          s.watchMs += d[1] - d[0];
          if (s.rawRanges.length < MAX_RAW_RANGES) s.rawRanges.push(d);
        }
        s.playedRanges = unionRanges([...s.playedRanges, ...deltas]);
        const r = typeof p.rendition === 'number' ? String(p.rendition) : null;
        if (r) s.renditions[r] = (s.renditions[r] ?? 0) + deltas.reduce((a, d) => a + d[1] - d[0], 0);
        break;
      }
      case 'play':
        if (p.source !== 'system') s.playCount++;
        break;
      case 'seek':
        s.seekCount++;
        break;
      case 'rebuffer_end':
        s.rebufferCount++;
        s.rebufferMs += Math.min(Number(p.duration_ms ?? 0), 10 * 60_000);
        break;
      case 'player_ready':
        if (s.startupMs === null && typeof p.startup_ms === 'number') s.startupMs = Math.round(p.startup_ms);
        break;
      case 'first_frame':
        if (s.ttffMs === null && typeof p.ttff_ms === 'number') s.ttffMs = Math.round(p.ttff_ms);
        break;
      case 'quality_change':
        s.qualitySwitches++;
        break;
      case 'ended':
        s.ended = true;
        break;
      case 'error':
        s.errors++;
        break;
      case 'session_end':
        s.exitReason = typeof p.exit_reason === 'string' ? p.exit_reason : 'closed';
        break;
    }
  }
  s.playedRanges = clampRanges(s.playedRanges, dur);
  s.uniqueWatchedMs = rangesLength(s.playedRanges);
  s.maxPositionMs = Math.max(s.maxPositionMs, maxEnd(s.playedRanges));
  s.completionPct =
    durationMs > 0 ? Math.min(100, Math.round((s.uniqueWatchedMs / durationMs) * 10000) / 100) : 0;
  s.quartiles = quartilesReached(s.completionPct);
  return s;
}
