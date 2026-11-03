import type { FastifyInstance } from 'fastify';
import { statfs } from 'node:fs/promises';
import type { AppContext } from '../context.js';
import { isAdminNetworkAllowed } from '../plugins/auth.js';
import { notFound } from '../lib/errors.js';

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Minimal Prometheus exposition (no client library): request latency histogram + operational gauges. */
export async function metricsRoutes(app: FastifyInstance, ctx: AppContext) {
  const hist = new Map<string, { buckets: number[]; sum: number; count: number }>();
  const counters = new Map<string, number>();
  const inc = (k: string, n = 1) => counters.set(k, (counters.get(k) ?? 0) + n);
  const label = (s: string) => s.replace(/["\\\n]/g, '_');

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    const key = `method="${req.method}",route="${label(route)}",status="${Math.floor(reply.statusCode / 100)}xx"`;
    const s = reply.elapsedTime / 1000;
    const h = hist.get(key) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
    BUCKETS.forEach((b, i) => s <= b && h.buckets[i]!++);
    h.sum += s;
    h.count++;
    hist.set(key, h);
    if (route === '/t/v1/events' || route === '/t/v1/beacon') {
      const accepted = (reply as unknown as { vsAccepted?: number }).vsAccepted;
      if (accepted) inc('vs_ingest_events_total', accepted);
      inc('vs_ingest_batches_total');
    }
  });

  app.get('/metrics', async (req, reply) => {
    if (!isAdminNetworkAllowed(ctx, req)) throw notFound();
    const sql = ctx.database.sql;
    const lines: string[] = [];
    const g = (name: string, help: string, type: 'gauge' | 'counter', samples: [string, number][]) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const [labels, v] of samples)
        lines.push(`${name}${labels ? `{${labels}}` : ''} ${Number.isFinite(v) ? v : 0}`);
    };
    lines.push(
      '# HELP vs_http_request_duration_seconds HTTP request latency',
      '# TYPE vs_http_request_duration_seconds histogram',
    );
    for (const [k, h] of hist) {
      BUCKETS.forEach((b, i) =>
        lines.push(`vs_http_request_duration_seconds_bucket{${k},le="${b}"} ${h.buckets[i]}`),
      );
      lines.push(`vs_http_request_duration_seconds_bucket{${k},le="+Inf"} ${h.count}`);
      lines.push(
        `vs_http_request_duration_seconds_sum{${k}} ${h.sum}`,
        `vs_http_request_duration_seconds_count{${k}} ${h.count}`,
      );
    }
    g('vs_ingest_events_total', 'Accepted telemetry events', 'counter', [
      ['', counters.get('vs_ingest_events_total') ?? 0],
    ]);
    g('vs_ingest_batches_total', 'Telemetry batches received', 'counter', [
      ['', counters.get('vs_ingest_batches_total') ?? 0],
    ]);
    const [queues, transcode, db, sessions] = await Promise.all([
      sql<
        { name: string; state: string; n: number }[]
      >`SELECT name, state, count(*)::int AS n FROM pgboss.job WHERE state IN ('created','retry','active','failed') GROUP BY 1, 2`.catch(
        () => [],
      ),
      sql<{ n: number; avg: number | null; max: number | null }[]>`
        SELECT count(*)::int AS n, avg(extract(epoch FROM finished_at - started_at))::float AS avg, max(extract(epoch FROM finished_at - started_at))::float AS max
        FROM transcode_jobs WHERE state = 'done' AND finished_at > now() - interval '24 hours'`,
      sql<{ size: number }[]>`SELECT pg_database_size(current_database())::bigint AS size`,
      sql<{ live: number; today: number }[]>`
        SELECT count(*) FILTER (WHERE last_seen_at > now() - interval '15 seconds' AND closed_at IS NULL)::int AS live,
               count(*) FILTER (WHERE started_at > date_trunc('day', now()))::int AS today FROM view_sessions WHERE started_at > now() - interval '2 days'`,
    ]);
    g(
      'vs_queue_jobs',
      'pg-boss jobs by queue and state',
      'gauge',
      queues.map((q) => [`queue="${label(q.name)}",state="${q.state}"`, q.n]),
    );
    g('vs_transcode_duration_seconds_avg', 'Average transcode duration (24 h)', 'gauge', [
      ['', transcode[0]?.avg ?? 0],
    ]);
    g('vs_transcode_duration_seconds_max', 'Maximum transcode duration (24 h)', 'gauge', [
      ['', transcode[0]?.max ?? 0],
    ]);
    g('vs_transcodes_completed_24h', 'Completed transcodes (24 h)', 'gauge', [['', transcode[0]?.n ?? 0]]);
    g('vs_database_size_bytes', 'Database size', 'gauge', [['', Number(db[0]?.size ?? 0)]]);
    g('vs_sessions_live', 'Sessions with a heartbeat in the last 15 s', 'gauge', [
      ['', sessions[0]?.live ?? 0],
    ]);
    g('vs_sessions_today', 'Sessions started today (UTC)', 'gauge', [['', sessions[0]?.today ?? 0]]);
    const disk = await statfs(ctx.config.MEDIA_ROOT).catch(() => null);
    if (disk) {
      g('vs_media_disk_free_bytes', 'Free space on the media volume', 'gauge', [
        ['', Number(disk.bavail) * Number(disk.bsize)],
      ]);
      g('vs_media_disk_size_bytes', 'Size of the media volume', 'gauge', [
        ['', Number(disk.blocks) * Number(disk.bsize)],
      ]);
    }
    const mem = process.memoryUsage();
    g('vs_process_resident_memory_bytes', 'API process RSS', 'gauge', [['', mem.rss]]);
    g('vs_process_uptime_seconds', 'API process uptime', 'gauge', [['', process.uptime()]]);
    reply
      .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
      .header('cache-control', 'no-store');
    return `${lines.join('\n')}\n`;
  });
}
