import { PREVIEW_SESSION, type Sql } from '@vs/core';
import { estimateFromSegments, quartilesReached, type Range } from '@vs/shared';

const IDLE = '30 minutes';

/**
 * Recomputes the server-side (segment-log) estimate for a session. If the session has no client
 * telemetry, the estimate is also the session's primary summary (`source = server`).
 */
export async function recomputeServerEstimate(sql: Sql, sessionId: string): Promise<void> {
  const rows = await sql<{ ts: Date; segment_index: number; rendition: number | null }[]>`
    SELECT ts, segment_index, rendition FROM segment_fetches
    WHERE session_id = ${sessionId} AND segment_index IS NOT NULL AND status IN (200, 206) ORDER BY ts`;
  const meta = await sql<{ duration_ms: number | null; closed_at: Date | null; source: string }[]>`
    SELECT v.duration_ms, s.closed_at, ss.source FROM view_sessions s JOIN videos v ON v.id = s.video_id
    JOIN session_summaries ss ON ss.session_id = s.id WHERE s.id = ${sessionId}`;
  const m = meta[0];
  if (!m || !rows.length) return;
  const dur = m.duration_ms ?? 0;
  const e = estimateFromSegments(
    rows.map((r) => ({ ts: r.ts.getTime(), index: r.segment_index, rendition: r.rendition })),
    dur,
    { sessionEnd: m.closed_at?.getTime() ?? null },
  );
  const completion = dur > 0 ? Math.min(100, Math.round((e.uniqueWatchedMs / dur) * 10000) / 100) : 0;
  const perRendition: Record<string, number> = {};
  for (const r of rows) if (r.rendition) perRendition[r.rendition] = (perRendition[r.rendition] ?? 0) + 4000;
  await sql`
    UPDATE session_summaries SET
      server_played_ranges = ${sql.json(e.played as never)}, server_unique_watched_ms = ${e.uniqueWatchedMs}, server_watch_ms = ${e.watchMs},
      updated_at = now()
    WHERE session_id = ${sessionId}`;
  if (m.source === 'server') {
    await sql`
      UPDATE session_summaries SET
        played_ranges = ${sql.json(e.played as never)}, raw_ranges = ${sql.json(e.raw as never)}, unique_watched_ms = ${e.uniqueWatchedMs},
        watch_ms = ${e.watchMs}, max_position_ms = ${e.played.reduce((x: number, r: Range) => Math.max(x, r[1]), 0)},
        completion_pct = ${completion}, quartiles = ${quartilesReached(completion)}, renditions = ${sql.json(perRendition as never)},
        play_count = greatest(play_count, ${e.raw.length ? 1 : 0}), seek_count = ${Math.max(0, e.raw.length - 1)},
        ended = ${dur > 0 && e.played.some((r: Range) => r[1] >= dur - 1000)}
      WHERE session_id = ${sessionId} AND source = 'server'`;
  }
  if (e.lastActivity) {
    await sql`UPDATE view_sessions SET last_seen_at = greatest(last_seen_at, ${new Date(e.lastActivity)}),
              first_play_at = coalesce(first_play_at, ${new Date(rows[0]!.ts)}) WHERE id = ${sessionId}`;
  }
}

/** Closes sessions without activity for 30 minutes; returns their ids. */
export async function closeIdleSessions(sql: Sql): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    UPDATE view_sessions SET closed_at = last_seen_at
    WHERE closed_at IS NULL AND last_seen_at < now() - ${IDLE}::interval AND id <> ${PREVIEW_SESSION}
    RETURNING id`;
  for (const r of rows) {
    await recomputeServerEstimate(sql, r.id);
    await sql`
      INSERT INTO events (session_id, seq, type, position_ms, payload)
      SELECT ${r.id}, coalesce(min(seq), 0) - 1, 'session_timeout', NULL, '{}'::jsonb FROM events WHERE session_id = ${r.id} AND seq < 0`;
    await sql`UPDATE session_summaries SET exit_reason = coalesce(exit_reason, 'idle') WHERE session_id = ${r.id}`;
  }
  return rows.map((r) => r.id);
}
