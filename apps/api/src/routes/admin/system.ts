import type { FastifyInstance } from 'fastify';
import { statfs, readFile } from 'node:fs/promises';
import path from 'node:path';
import { adminSecurityWarnings, geoIp } from '@vs/core';
import type { AppContext } from '../../context.js';
import { requireRole } from '../../plugins/auth.js';

export async function systemRoutes(app: FastifyInstance, ctx: AppContext) {
  const sql = ctx.database.sql;
  app.get('/system', { preValidation: requireRole('editor') }, async () => {
    const disk = await statfs(ctx.config.MEDIA_ROOT).catch(() => null);
    const [queues, dbSize, counts, failedJobs, backup] = await Promise.all([
      sql`SELECT name, state, count(*)::int AS n FROM pgboss.job GROUP BY 1, 2 ORDER BY 1, 2`.catch(() => []),
      sql<{ size: number }[]>`SELECT pg_database_size(current_database())::bigint AS size`,
      sql<Record<string, number>[]>`
        SELECT (SELECT count(*) FROM videos WHERE deleted_at IS NULL)::int AS videos, (SELECT count(*) FROM share_links WHERE deleted_at IS NULL)::int AS links,
               (SELECT count(*) FROM view_sessions)::int AS sessions, (SELECT count(*) FROM events)::bigint AS events,
               (SELECT count(*) FROM segment_fetches)::bigint AS "segmentFetches"`,
      sql`SELECT name, output->>'message' AS error, completed_on AS "at" FROM pgboss.job WHERE state = 'failed' ORDER BY completed_on DESC NULLS LAST LIMIT 10`.catch(
        () => [],
      ),
      readFile(path.join(ctx.config.MEDIA_ROOT, '.backup-status.json'), 'utf8')
        .then((t) => JSON.parse(t) as unknown)
        .catch(() => null),
    ]);
    const geo = await geoIp(ctx.config.GEOIP_DIR);
    return {
      version: ctx.config.BUILD_VERSION,
      health: 'ok',
      security: {
        adminListener: ctx.config.ADMIN_LISTENER,
        sessionIdleMinutes: ctx.config.ADMIN_SESSION_IDLE_MINUTES,
        reauthMinutes: ctx.config.ADMIN_REAUTH_MINUTES,
        warnings: adminSecurityWarnings(ctx.config),
      },
      disk: disk
        ? { total: Number(disk.blocks) * Number(disk.bsize), free: Number(disk.bavail) * Number(disk.bsize) }
        : null,
      databaseBytes: dbSize[0]!.size,
      counts: counts[0],
      queues,
      failedJobs,
      geoip: {
        ...geo.available,
        source: ctx.config.GEOIP_AUTO_UPDATE === 'dbip' ? 'DB-IP Lite (CC BY 4.0)' : 'manual',
      },
      backup,
    };
  });
}
