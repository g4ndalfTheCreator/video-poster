import type { Logger } from 'pino';
import { getSettings, type Sql } from '@vs/core';

export interface RetentionResult {
  droppedEventPartitions: string[];
  archivedSegmentPartitions: string[];
  clearedSignals: number;
  deletedSessions: number;
  deletedEventRows: number;
}

/**
 * Applies the retention settings:
 * - `events` (raw JS events): monthly partitions entirely older than `eventsDays` are dropped; rows of
 *   the partially expired partition are deleted.
 * - browser-profile `signals` older than `fingerprintSignalsDays` are cleared (the hash stays).
 * - `segment_fetches` partitions older than `archiveAfterMonths` move to the `archive` schema (still
 *   queryable), unless server data has a finite retention, in which case expired partitions are dropped.
 * - with `serverData = N days`, sessions older than N days are deleted (cascades) — default is `forever`.
 */
export async function runRetention(sql: Sql, log: Logger, now = new Date()): Promise<RetentionResult> {
  const r = (await getSettings(sql, true)).retention;
  const res: RetentionResult = {
    droppedEventPartitions: [],
    archivedSegmentPartitions: [],
    clearedSignals: 0,
    deletedSessions: 0,
    deletedEventRows: 0,
  };
  const eventsCutoff = new Date(now.getTime() - r.eventsDays * 86400_000);

  const parts = async (parent: string) =>
    sql<{ name: string; upper: Date | null }[]>`
      SELECT c.relname AS name, partition_upper_bound(c.oid) AS upper
      FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = ${parent}::regclass AND c.relname <> ${parent + '_default'}`;

  for (const p of await parts('events')) {
    if (p.upper && p.upper <= eventsCutoff) {
      await sql.unsafe(`DROP TABLE public."${p.name.replace(/"/g, '')}"`);
      res.droppedEventPartitions.push(p.name);
    }
  }
  const del = await sql`DELETE FROM events WHERE server_ts < ${eventsCutoff}`;
  res.deletedEventRows = del.count;

  const signalsCutoff = new Date(now.getTime() - r.fingerprintSignalsDays * 86400_000);
  const cleared =
    await sql`UPDATE browser_fingerprints SET signals = NULL WHERE signals IS NOT NULL AND last_seen_at < ${signalsCutoff}`;
  res.clearedSignals = cleared.count;

  const serverCutoff = r.serverData === 'forever' ? null : new Date(now.getTime() - r.serverData * 86400_000);
  const archiveCutoff = new Date(now);
  archiveCutoff.setUTCMonth(archiveCutoff.getUTCMonth() - r.archiveAfterMonths);
  for (const p of await parts('segment_fetches')) {
    if (!p.upper) continue;
    if (serverCutoff && p.upper <= serverCutoff) {
      await sql.unsafe(`DROP TABLE public."${p.name.replace(/"/g, '')}"`);
    } else if (p.upper <= archiveCutoff) {
      // Detached partitions keep their data in the archive schema (no FK, still queryable).
      await sql.unsafe(`ALTER TABLE segment_fetches DETACH PARTITION public."${p.name}"`);
      await sql.unsafe(`ALTER TABLE public."${p.name}" SET SCHEMA archive`);
      res.archivedSegmentPartitions.push(p.name);
    }
  }
  if (serverCutoff) {
    const d = await sql`DELETE FROM view_sessions WHERE started_at < ${serverCutoff}`;
    res.deletedSessions = d.count;
    await sql`DELETE FROM link_previews WHERE fetched_at < ${serverCutoff}`;
    await sql`DELETE FROM link_events WHERE ts < ${serverCutoff}`;
    await sql`DELETE FROM daily_rollups WHERE date < ${serverCutoff}::date`;
    await sql`DELETE FROM visitors v WHERE NOT EXISTS (SELECT 1 FROM view_sessions s WHERE s.visitor_id = v.id) AND last_seen_at < ${serverCutoff}`;
    await sql`DELETE FROM browser_fingerprints f WHERE NOT EXISTS (SELECT 1 FROM view_sessions s WHERE s.fingerprint_id = f.id) AND last_seen_at < ${serverCutoff}`;
  }
  await sql`DELETE FROM rate_limits WHERE reset_at < now()`;
  await sql`DELETE FROM admin_sessions WHERE absolute_expires_at < now() OR expires_at < now() - interval '1 day'`;
  log.info(res, 'retention applied');
  return res;
}
