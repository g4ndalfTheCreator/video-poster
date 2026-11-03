import type { Sql } from '@vs/core';

/** Ensures monthly partitions exist 3 months ahead for partitioned telemetry tables. */
export async function ensurePartitions(sql: Sql): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT ensure_month_partitions('events', 3) + ensure_month_partitions('segment_fetches', 3) AS n`;
  return rows[0]?.n ?? 0;
}
