import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export async function healthRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/healthz', async (_req, reply) => {
    const started = performance.now();
    let db: 'ok' | 'error' = 'ok';
    let migrations = 0;
    try {
      const rows = await ctx.database.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM schema_migrations`;
      migrations = rows[0]?.n ?? 0;
    } catch {
      db = 'error';
    }
    const body = {
      status: db === 'ok' ? 'ok' : 'degraded',
      db,
      migrations,
      dbLatencyMs: Math.round(performance.now() - started),
      version: ctx.config.BUILD_VERSION,
    };
    return reply
      .code(db === 'ok' ? 200 : 503)
      .header('cache-control', 'no-store')
      .send(body);
  });
}
