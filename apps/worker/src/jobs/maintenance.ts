import { purgeVideo, type Sql } from '@vs/core';

/** Ensures monthly partitions exist 3 months ahead for partitioned telemetry tables. */
export async function ensurePartitions(sql: Sql): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT ensure_month_partitions('events', 3) + ensure_month_partitions('segment_fetches', 3) AS n`;
  return rows[0]?.n ?? 0;
}

/** Permanently deletes videos that have been in the trash for 30 days. */
export async function purgeTrash(sql: Sql, mediaRoot: string): Promise<number> {
  const rows = await sql<
    { id: string }[]
  >`SELECT id FROM videos WHERE deleted_at < now() - interval '30 days'`;
  for (const r of rows) await purgeVideo(sql, mediaRoot, r.id);
  return rows.length;
}
