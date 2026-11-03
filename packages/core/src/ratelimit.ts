import type { Sql } from './db.js';

/**
 * Fixed-window counter stored in Postgres so it survives restarts and works across api replicas.
 * Returns the count after increment and whether the limit is exceeded.
 */
export async function hitRateLimit(
  sql: Sql,
  key: string,
  limit: number,
  windowSec: number,
): Promise<{ count: number; limited: boolean; resetAt: Date }> {
  const rows = await sql<{ count: number; reset_at: Date }[]>`
    INSERT INTO rate_limits (key, count, reset_at) VALUES (${key}, 1, now() + make_interval(secs => ${windowSec}))
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rate_limits.reset_at < now() THEN 1 ELSE rate_limits.count + 1 END,
      reset_at = CASE WHEN rate_limits.reset_at < now() THEN now() + make_interval(secs => ${windowSec}) ELSE rate_limits.reset_at END
    RETURNING count, reset_at`;
  const r = rows[0]!;
  return { count: r.count, limited: r.count > limit, resetAt: r.reset_at };
}

export async function peekRateLimit(sql: Sql, key: string): Promise<number> {
  const rows = await sql<
    { count: number }[]
  >`SELECT count FROM rate_limits WHERE key = ${key} AND reset_at > now()`;
  return rows[0]?.count ?? 0;
}

export async function clearRateLimit(sql: Sql, key: string): Promise<void> {
  await sql`DELETE FROM rate_limits WHERE key = ${key}`;
}
