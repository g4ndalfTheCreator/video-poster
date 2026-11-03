import { randomToken, sha256Hex, type Sql } from '@vs/core';

/**
 * When no admin user exists, creates a one-time bootstrap token and returns it so it can be
 * printed to the console. Returns null once an owner exists.
 */
export async function ensureBootstrapToken(sql: Sql): Promise<string | null> {
  const users = await sql<
    { n: number }[]
  >`SELECT count(*)::int AS n FROM admin_users WHERE deleted_at IS NULL`;
  if ((users[0]?.n ?? 0) > 0) {
    await sql`DELETE FROM bootstrap_tokens`;
    return null;
  }
  const token = randomToken(24);
  await sql`DELETE FROM bootstrap_tokens`;
  await sql`INSERT INTO bootstrap_tokens (token_hash) VALUES (${sha256Hex(token)})`;
  return token;
}
