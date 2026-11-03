/**
 * pnpm seed:telemetry [--sessions 20000] [--videos 4] [--links 12] [--days 90]
 * Synthetic telemetry for dashboard development. Never run against production data.
 */
import { createDatabase, migrate } from '@vs/core';
import { seedTelemetry } from './telemetry/seed.js';

const arg = (name: string, def: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const db = createDatabase(url, { max: 2 });
await migrate(db.sql);
const started = Date.now();
const r = await seedTelemetry(db.sql, {
  sessions: arg('sessions', 20_000),
  videos: arg('videos', 4),
  linksPerVideo: arg('links', 12),
  days: arg('days', 90),
});
console.warn(
  `seeded ${r.videoIds.length} videos, ${r.linkIds.length} links in ${((Date.now() - started) / 1000).toFixed(1)} s`,
);
await db.close();
