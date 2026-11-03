import { settingsSchema, type Settings } from '@vs/shared';
import type { Sql } from './db.js';

const KEY = 'app';
let cache: { value: Settings; at: number } | undefined;
const TTL_MS = 5000;

export async function getSettings(sql: Sql, fresh = false): Promise<Settings> {
  if (!fresh && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const rows = await sql<{ value: unknown }[]>`SELECT value FROM settings WHERE key = ${KEY}`;
  const value = settingsSchema.parse(rows[0]?.value ?? {});
  cache = { value, at: Date.now() };
  return value;
}

export async function putSettings(sql: Sql, patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings(sql, true);
  const next = settingsSchema.parse({ ...current, ...patch });
  await sql`
    INSERT INTO settings (key, value, updated_at) VALUES (${KEY}, ${sql.json(next as never)}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  cache = { value: next, at: Date.now() };
  return next;
}

export function invalidateSettingsCache(): void {
  cache = undefined;
}
