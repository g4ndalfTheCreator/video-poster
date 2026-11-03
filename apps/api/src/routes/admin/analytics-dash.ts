import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit, getSettings, LIVE_CHANNEL, newId, type Sql } from '@vs/core';
import {
  dropOffPoints,
  idParams,
  LIVE_WINDOW_MS,
  percentile,
  rebufferRatio,
  RETENTION_BUCKETS,
  sessionFilterQuery,
  visitorMergeSchema,
  visitorPatchSchema,
} from '@vs/shared';
import type { AppContext } from '../../context.js';
import { requireRole } from '../../plugins/auth.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { offset, orderBy } from '../../lib/paging.js';
import { previewUrls } from '../../lib/media-urls.js';
import { startSse } from '../../lib/sse.js';
import type { PgNotifications } from '../../lib/notify.js';
import { canSeeIdentifiers } from './analytics.js';

const dateRe = /^\d{4}-\d{2}-\d{2}$/;
const rangeQuery = z.object({
  from: z.string().regex(dateRe).optional(),
  to: z.string().regex(dateRe).optional(),
  videoId: z.string().uuid().optional(),
  linkId: z.string().uuid().optional(),
});

interface Range {
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  days: number;
  tz: string;
}

async function resolveRange(sql: Sql, q: { from?: string; to?: string }, defaultDays = 30): Promise<Range> {
  const tz = (await getSettings(sql)).ui.timezone;
  const r = await sql<Range[]>`
    WITH b AS (
      SELECT coalesce(${q.to ?? null}::date, (now() AT TIME ZONE ${tz})::date) AS t,
             coalesce(${q.from ?? null}::date, (now() AT TIME ZONE ${tz})::date - ${defaultDays - 1}::int) AS f
    )
    SELECT f::text AS from, t::text AS to, (f - (t - f + 1))::text AS "prevFrom", (f - 1)::text AS "prevTo", (t - f + 1) AS days, ${tz} AS tz FROM b`;
  if (r[0]!.days <= 0 || r[0]!.days > 3660) throw badRequest('invalid date range');
  return r[0]!;
}

const rollupFilter = (sql: Sql, q: { videoId?: string; linkId?: string }) =>
  sql`${q.videoId ? sql`AND r.video_id = ${q.videoId}` : sql``} ${q.linkId ? sql`AND r.link_id = ${q.linkId}` : sql``}`;

/** Merges per-day {key: count} objects of several rollup rows. */
function mergeCounts(rows: Record<string, number>[], top = 12): { key: string; count: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) for (const [k, v] of Object.entries(r ?? {})) m.set(k, (m.get(k) ?? 0) + Number(v));
  return [...m.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, top);
}

export async function dashboardRoutes(
  fastify: FastifyInstance,
  ctx: AppContext,
  notifications: PgNotifications,
) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const sql = ctx.database.sql;
  const tokenOk = { allowApiToken: true };

  const kpis = async (from: string, to: string, q: { videoId?: string; linkId?: string }, tz: string) => {
    const r = await sql<Record<string, number>[]>`
      SELECT coalesce(sum(sessions), 0)::int AS sessions, coalesce(sum(views), 0)::int AS views, coalesce(sum(plays), 0)::int AS plays,
             coalesce(sum(watch_ms), 0)::bigint AS "watchMs", coalesce(sum(completions), 0)::int AS completions,
             coalesce(round(sum(avg_completion_pct * views) / nullif(sum(views), 0), 2), 0)::float AS "avgCompletionPct",
             coalesce(sum(previews), 0)::int AS previews, coalesce(sum(cta_clicks), 0)::int AS "ctaClicks"
      FROM daily_rollups r WHERE r.date BETWEEN ${from}::date AND ${to}::date ${rollupFilter(sql, q)}`;
    const u = await sql<{ n: number }[]>`
      SELECT count(DISTINCT coalesce(visitor_id::text, visitor_hash, id::text))::int AS n FROM view_sessions
      WHERE NOT is_bot AND started_at >= (${from}::date::timestamp AT TIME ZONE ${tz}) AND started_at < ((${to}::date + 1)::timestamp AT TIME ZONE ${tz})
      ${q.videoId ? sql`AND video_id = ${q.videoId}` : sql``} ${q.linkId ? sql`AND link_id = ${q.linkId}` : sql``}`;
    const k = r[0]!;
    return {
      ...k,
      uniqueVisitors: u[0]!.n,
      completionRate: k.views ? Math.round(((k.completions ?? 0) / k.views) * 1000) / 10 : 0,
    };
  };

  app.get('/analytics/overview', { schema: { querystring: rangeQuery }, config: tokenOk }, async (req) => {
    const q = req.query;
    const range = await resolveRange(sql, q);
    const [current, previous, series, topVideos, topLinks, recent, live, firstOpens] = await Promise.all([
      kpis(range.from, range.to, q, range.tz),
      kpis(range.prevFrom, range.prevTo, q, range.tz),
      sql`SELECT d::date::text AS date, coalesce(sum(r.sessions), 0)::int AS sessions, coalesce(sum(r.views), 0)::int AS views,
                 coalesce(sum(r.watch_ms), 0)::bigint AS "watchMs"
          FROM generate_series(${range.from}::date, ${range.to}::date, interval '1 day') d
          LEFT JOIN daily_rollups r ON r.date = d::date ${rollupFilter(sql, q)}
          GROUP BY d ORDER BY d`,
      sql`SELECT r.video_id AS id, v.title, sum(r.sessions)::int AS sessions, sum(r.views)::int AS views,
                 round(sum(r.avg_completion_pct * r.views) / nullif(sum(r.views), 0), 1)::float AS "avgCompletionPct"
          FROM daily_rollups r JOIN videos v ON v.id = r.video_id
          WHERE r.date BETWEEN ${range.from}::date AND ${range.to}::date ${rollupFilter(sql, q)}
          GROUP BY 1, 2 HAVING sum(r.sessions) > 0 ORDER BY sessions DESC LIMIT 5`,
      sql`SELECT r.link_id AS id, l.label, l.recipient_name AS "recipientName", v.title AS "videoTitle", sum(r.sessions)::int AS sessions,
                 sum(r.views)::int AS views, round(sum(r.avg_completion_pct * r.views) / nullif(sum(r.views), 0), 1)::float AS "avgCompletionPct"
          FROM daily_rollups r JOIN share_links l ON l.id = r.link_id JOIN videos v ON v.id = r.video_id
          WHERE r.date BETWEEN ${range.from}::date AND ${range.to}::date ${rollupFilter(sql, q)}
          GROUP BY 1, 2, 3, 4 HAVING sum(r.sessions) > 0 ORDER BY sessions DESC LIMIT 5`,
      sql`SELECT l.id, l.label, l.recipient_name AS "recipientName", v.title AS "videoTitle", l.last_opened_at AS "lastOpenedAt", l.session_count AS sessions
          FROM share_links l JOIN videos v ON v.id = l.video_id
          WHERE l.last_opened_at IS NOT NULL AND l.deleted_at IS NULL ${q.videoId ? sql`AND l.video_id = ${q.videoId}` : sql``}
          ORDER BY l.last_opened_at DESC LIMIT 8`,
      liveSessions(),
      sql`SELECT l.id, l.label, v.title AS "videoTitle", l.first_notified_at AS "at" FROM share_links l JOIN videos v ON v.id = l.video_id
          WHERE l.first_notified_at IS NOT NULL ORDER BY l.first_notified_at DESC LIMIT 5`,
    ]);
    return { range, current, previous, series, topVideos, topLinks, recent, live, firstOpens };
  });

  async function liveSessions() {
    return sql`
      SELECT s.id, s.link_id AS "linkId", l.label, v.title AS "videoTitle", v.duration_ms AS "durationMs", s.city, s.country, s.device_type AS "device",
             ss.max_position_ms AS "positionMs", ss.completion_pct AS "completionPct", s.last_seen_at AS "lastSeenAt"
      FROM view_sessions s JOIN share_links l ON l.id = s.link_id JOIN videos v ON v.id = s.video_id
      JOIN session_summaries ss ON ss.session_id = s.id
      WHERE s.last_seen_at > now() - make_interval(secs => ${LIVE_WINDOW_MS / 1000}) AND NOT s.is_bot AND s.closed_at IS NULL
      ORDER BY s.last_seen_at DESC LIMIT 50`;
  }

  app.get('/analytics/live', async (req, reply) => {
    let unsubscribe = () => {};
    const send = startSse(req, reply, () => unsubscribe());
    send('snapshot', await liveSessions());
    unsubscribe = notifications.subscribe(LIVE_CHANNEL, (e) => send('heartbeat', e));
  });

  app.get(
    '/analytics/videos/:id',
    { schema: { params: idParams, querystring: rangeQuery.omit({ videoId: true }) }, config: tokenOk },
    async (req) => {
      const q = { ...req.query, videoId: req.params.id };
      const v = await sql<{ id: string; title: string; duration_ms: number | null; hls_version: number }[]>`
      SELECT id, title, duration_ms, hls_version FROM videos WHERE id = ${req.params.id}`;
      if (!v[0]) throw notFound('video');
      const range = await resolveRange(sql, q, 3650);
      const [buckets, dims, linkRows, kpi, maxima] = await Promise.all([
        sql<{ bucket: number; viewers: number; rewatches: number }[]>`
        SELECT bucket, sum(viewers)::int AS viewers, sum(rewatches)::int AS rewatches FROM retention_buckets
        WHERE video_id = ${req.params.id} ${q.linkId ? sql`AND link_id = ${q.linkId}` : sql``} GROUP BY bucket ORDER BY bucket`,
        sql<
          {
            c: Record<string, number>;
            d: Record<string, number>;
            r: Record<string, number>;
            n: Record<string, number>;
            o: Record<string, number>;
          }[]
        >`
        SELECT by_country AS c, by_device AS d, by_referrer AS r, by_network_type AS n, by_org AS o FROM daily_rollups r
        WHERE r.date BETWEEN ${range.from}::date AND ${range.to}::date ${rollupFilter(sql, q)}`,
        sql`SELECT l.id, l.label, l.recipient_name AS "recipientName", l.recipient_org AS "recipientOrg", l.last_opened_at AS "lastOpenedAt",
                 coalesce(sum(r.sessions), 0)::int AS sessions, coalesce(sum(r.views), 0)::int AS views,
                 coalesce(round(sum(r.avg_completion_pct * r.views) / nullif(sum(r.views), 0), 1), 0)::float AS "avgCompletionPct",
                 coalesce(sum(r.previews), 0)::int AS previews, coalesce(sum(r.cta_clicks), 0)::int AS "ctaClicks"
          FROM share_links l LEFT JOIN daily_rollups r ON r.link_id = l.id AND r.date BETWEEN ${range.from}::date AND ${range.to}::date
          WHERE l.video_id = ${req.params.id} AND l.deleted_at IS NULL GROUP BY l.id ORDER BY sessions DESC, l.created_at DESC LIMIT 200`,
        kpis(range.from, range.to, q, range.tz),
        sql<{ link_id: string; m: number }[]>`
        SELECT s.link_id, max(ss.completion_pct)::float AS m FROM view_sessions s JOIN session_summaries ss ON ss.session_id = s.id
        WHERE s.video_id = ${req.params.id} AND NOT s.is_bot GROUP BY 1`,
      ]);
      const maxBy = new Map(maxima.map((m) => [m.link_id, m.m]));
      const links = linkRows.map((l) => ({ ...l, maxCompletionPct: maxBy.get(l.id as string) ?? null }));
      const views = Math.max(0, ...buckets.map((b) => b.viewers));
      const curve = Array.from({ length: RETENTION_BUCKETS }, (_, i) => buckets.find((b) => b.bucket === i));
      const retention = curve.map((b) => (views ? (b?.viewers ?? 0) / views : 0));
      const rewatch = curve.map((b) => (views ? (b?.rewatches ?? 0) / views : 0));
      const dur = v[0].duration_ms ?? 0;
      return {
        video: {
          id: v[0].id,
          title: v[0].title,
          durationMs: dur,
          preview: previewUrls(ctx.config, v[0].id, v[0].hls_version),
        },
        range,
        kpis: kpi,
        retention,
        rewatch,
        viewsInCurve: views,
        dropOffs: dropOffPoints(retention, dur, 5),
        byCountry: mergeCounts(dims.map((d) => d.c)),
        byDevice: mergeCounts(dims.map((d) => d.d)),
        byReferrer: mergeCounts(dims.map((d) => d.r)),
        byNetworkType: mergeCounts(dims.map((d) => d.n)),
        byOrg: mergeCounts(dims.map((d) => d.o)),
        links,
      };
    },
  );

  /** Recipient view of one link. */
  app.get('/analytics/links/:id', { schema: { params: idParams }, config: tokenOk }, async (req) => {
    const privileged = canSeeIdentifiers(req.admin!.role);
    const l = await sql<Record<string, unknown>[]>`
      SELECT l.id, l.label, l.recipient_name, l.recipient_org, l.first_opened_at, l.last_opened_at, l.video_id, v.duration_ms
      FROM share_links l JOIN videos v ON v.id = l.video_id WHERE l.id = ${req.params.id}`;
    if (!l[0]) throw notFound('link');
    const [sessions, previews, totals, events] = await Promise.all([
      sql<Record<string, unknown>[]>`
        SELECT s.id, s.started_at AS "startedAt", s.last_seen_at AS "lastSeenAt", host(s.ip) AS ip, s.city, s.country, s.device_type AS device,
               s.os, s.browser, s.is_bot AS "isBot", i.network_type AS "networkType", coalesce(i.org_guess, s.as_org) AS org, i.confidence,
               ss.completion_pct AS "completionPct", ss.unique_watched_ms AS "uniqueWatchedMs", ss.source, ss.cta_clicks AS "ctaClicks",
               ss.attachment_downloads AS "attachmentDownloads", s.visitor_id AS "visitorId", s.visitor_confidence AS "visitorConfidence",
               vis.label AS "visitorLabel",
               (SELECT count(DISTINCT x.link_id)::int FROM view_sessions x WHERE x.visitor_id = s.visitor_id AND x.link_id <> s.link_id) AS "otherLinks"
        FROM view_sessions s LEFT JOIN session_summaries ss ON ss.session_id = s.id LEFT JOIN ip_intel i ON i.id = s.ip_intel_id
        LEFT JOIN visitors vis ON vis.id = s.visitor_id
        WHERE s.link_id = ${req.params.id} ORDER BY s.started_at DESC LIMIT 500`,
      sql`SELECT p.fetched_at AS "fetchedAt", p.bot_name AS "botName", p.country, coalesce(i.org_guess, i.as_org) AS org, i.network_type AS "networkType"
          FROM link_previews p LEFT JOIN ip_intel i ON i.id = p.ip_intel_id WHERE p.link_id = ${req.params.id} ORDER BY p.fetched_at DESC LIMIT 100`,
      sql<Record<string, number>[]>`
        SELECT count(*) FILTER (WHERE NOT s.is_bot)::int AS sessions, coalesce(max(ss.completion_pct) FILTER (WHERE NOT s.is_bot), 0)::float AS "maxCompletionPct",
               coalesce(sum(ss.cta_clicks), 0)::int AS "ctaClicks", coalesce(sum(ss.attachment_downloads), 0)::int AS "attachmentDownloads",
               coalesce(sum(ss.video_downloads), 0)::int AS "videoDownloads", coalesce(sum(ss.watch_ms) FILTER (WHERE NOT s.is_bot), 0)::bigint AS "watchMs"
        FROM view_sessions s LEFT JOIN session_summaries ss ON ss.session_id = s.id WHERE s.link_id = ${req.params.id}`,
      sql`SELECT type, ts FROM link_events WHERE link_id = ${req.params.id} ORDER BY ts DESC LIMIT 50`,
    ]);
    if (privileged && req.admin!.kind === 'user') {
      await audit(sql, {
        actorUserId: req.admin!.userId,
        action: 'telemetry.link_view',
        entity: 'share_link',
        entityId: req.params.id,
        ip: req.clientIp,
      });
    }
    const humans = sessions.filter((s) => !s.isBot);
    return {
      link: l[0],
      opened: humans.length > 0,
      firstOpenedAt: humans.length ? humans[humans.length - 1]!.startedAt : null,
      lastOpenedAt: humans[0]?.startedAt ?? null,
      totals: totals[0],
      sessions: sessions.map((s) => ({ ...s, ip: privileged ? s.ip : null })),
      previews,
      linkEvents: events,
    };
  });

  app.get(
    '/analytics/sessions',
    { schema: { querystring: sessionFilterQuery }, config: tokenOk },
    async (req) => {
      const q = req.query;
      const privileged = canSeeIdentifiers(req.admin!.role);
      const range = await resolveRange(sql, q, 3650);
      const { col, dir } = orderBy(
        q,
        {
          startedAt: 's.started_at',
          completion: 'ss.completion_pct',
          watch: 'ss.unique_watched_ms',
          country: 's.country',
          link: 'l.label',
        },
        'startedAt',
      );
      if (q.ip && !privileged) throw badRequest('IP search requires editor role');
      const where = sql`WHERE s.started_at >= (${range.from}::date::timestamp AT TIME ZONE ${range.tz})
        AND s.started_at < ((${range.to}::date + 1)::timestamp AT TIME ZONE ${range.tz})
        ${q.hideBots ? sql`AND NOT s.is_bot` : sql``}
        ${q.videoId ? sql`AND s.video_id = ${q.videoId}` : sql``}
        ${q.linkId ? sql`AND s.link_id = ${q.linkId}` : sql``}
        ${q.visitorId ? sql`AND s.visitor_id = ${q.visitorId}` : sql``}
        ${q.country ? sql`AND s.country = ${q.country.toUpperCase()}` : sql``}
        ${q.device ? sql`AND s.device_type = ${q.device}` : sql``}
        ${q.ip ? (q.ip.includes('/') ? sql`AND s.ip <<= ${q.ip}::cidr` : sql`AND s.ip = ${q.ip}::inet`) : sql``}
        ${q.q ? sql`AND (l.label ILIKE ${'%' + q.q + '%'} OR l.recipient_name ILIKE ${'%' + q.q + '%'} OR i.org_guess ILIKE ${'%' + q.q + '%'} OR s.city ILIKE ${'%' + q.q + '%'})` : sql``}`;
      const items = await sql`
      SELECT s.id, s.started_at AS "startedAt", s.link_id AS "linkId", l.label AS "linkLabel", l.recipient_name AS "recipientName",
             s.video_id AS "videoId", v.title AS "videoTitle", s.city, s.country, s.device_type AS device, s.browser, s.os, s.is_bot AS "isBot",
             ${privileged ? sql`host(s.ip)` : sql`NULL`} AS ip, i.network_type AS "networkType", coalesce(i.org_guess, s.as_org) AS org,
             i.confidence, ss.completion_pct AS "completionPct", ss.unique_watched_ms AS "uniqueWatchedMs", ss.source,
             s.visitor_id AS "visitorId", vis.label AS "visitorLabel", s.closed_at IS NULL AND s.last_seen_at > now() - interval '15 seconds' AS live
      FROM view_sessions s JOIN share_links l ON l.id = s.link_id JOIN videos v ON v.id = s.video_id
      LEFT JOIN session_summaries ss ON ss.session_id = s.id LEFT JOIN ip_intel i ON i.id = s.ip_intel_id LEFT JOIN visitors vis ON vis.id = s.visitor_id
      ${where} ORDER BY ${sql.unsafe(col)} ${sql.unsafe(dir)} NULLS LAST, s.id DESC LIMIT ${q.pageSize} OFFSET ${offset(q)}`;
      const total = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM view_sessions s JOIN share_links l ON l.id = s.link_id LEFT JOIN ip_intel i ON i.id = s.ip_intel_id ${where}`;
      if (q.ip && req.admin!.kind === 'user') {
        await audit(sql, {
          actorUserId: req.admin!.userId,
          action: 'telemetry.ip_search',
          diff: { ip: q.ip },
          ip: req.clientIp,
        });
      }
      return { items, total: total[0]!.n, page: q.page, pageSize: q.pageSize };
    },
  );

  app.get('/analytics/quality', { schema: { querystring: rangeQuery }, config: tokenOk }, async (req) => {
    const q = req.query;
    const range = await resolveRange(sql, q);
    const from = sql`FROM view_sessions s JOIN session_summaries ss ON ss.session_id = s.id`;
    const where = sql`WHERE NOT s.is_bot AND ss.source = 'client' AND s.started_at >= (${range.from}::date::timestamp AT TIME ZONE ${range.tz})
        AND s.started_at < ((${range.to}::date + 1)::timestamp AT TIME ZONE ${range.tz})
        ${q.videoId ? sql`AND s.video_id = ${q.videoId}` : sql``} ${q.linkId ? sql`AND s.link_id = ${q.linkId}` : sql``}`;
    const base = sql`${from} ${where}`;
    const [timing, rendition, errors, byBrowser] = await Promise.all([
      sql<{ startup: number[]; ttff: number[]; rebuffer: number; watch: number }[]>`
        SELECT coalesce(array_agg(ss.startup_ms) FILTER (WHERE ss.startup_ms IS NOT NULL), '{}') AS startup,
               coalesce(array_agg(ss.ttff_ms) FILTER (WHERE ss.ttff_ms IS NOT NULL), '{}') AS ttff,
               coalesce(sum(ss.rebuffer_ms), 0)::bigint AS rebuffer, coalesce(sum(ss.watch_ms), 0)::bigint AS watch ${base}`,
      sql<
        { k: string; ms: number }[]
      >`SELECT k, sum(v::bigint)::bigint AS ms ${from} CROSS JOIN LATERAL jsonb_each_text(ss.renditions) AS r(k, v) ${where} GROUP BY k ORDER BY k::int DESC`,
      sql`SELECT coalesce(e.payload->>'code', 'unknown') AS code, count(*)::int AS n, count(*) FILTER (WHERE (e.payload->>'fatal')::boolean)::int AS fatal
          FROM events e JOIN view_sessions s ON s.id = e.session_id
          WHERE e.type = 'error' AND e.server_ts >= (${range.from}::date::timestamp AT TIME ZONE ${range.tz})
            ${q.videoId ? sql`AND s.video_id = ${q.videoId}` : sql``}
          GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
      sql`SELECT coalesce(s.browser, '?') AS browser, count(*)::int AS sessions, coalesce(sum(ss.errors), 0)::int AS errors ${base} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
    ]);
    const t = timing[0]!;
    const totalMs = rendition.reduce((a, r) => a + Number(r.ms), 0);
    return {
      range,
      startupP50: percentile(t.startup, 50),
      startupP95: percentile(t.startup, 95),
      ttffP50: percentile(t.ttff, 50),
      ttffP95: percentile(t.ttff, 95),
      rebufferRatio: rebufferRatio(Number(t.rebuffer), Number(t.watch)),
      renditions: rendition.map((r) => ({
        height: Number(r.k),
        share: totalMs ? Number(r.ms) / totalMs : 0,
      })),
      errors,
      byBrowser,
    };
  });

  /** CSV/JSON export of sessions, daily rollups or links. */
  app.get(
    '/analytics/export',
    {
      schema: {
        querystring: rangeQuery.extend({
          format: z.enum(['csv', 'json']).default('csv'),
          view: z.enum(['sessions', 'daily', 'links']).default('sessions'),
        }),
      },
      config: tokenOk,
    },
    async (req, reply) => {
      const q = req.query;
      const range = await resolveRange(sql, q, 3650);
      const privileged = canSeeIdentifiers(req.admin!.role);
      let rows: Record<string, unknown>[];
      if (q.view === 'daily') {
        rows = await sql`
          SELECT r.date::text, r.video_id, v.title AS video_title, r.link_id, l.label AS link_label, r.sessions, r.unique_visitors, r.plays, r.views,
                 r.watch_ms, r.completions, r.avg_completion_pct, r.bot_sessions, r.previews, r.cta_clicks, r.attachment_downloads
          FROM daily_rollups r JOIN videos v ON v.id = r.video_id JOIN share_links l ON l.id = r.link_id
          WHERE r.date BETWEEN ${range.from}::date AND ${range.to}::date ${rollupFilter(sql, q)} ORDER BY r.date, v.title, l.label`;
      } else if (q.view === 'links') {
        rows = await sql`
          SELECT l.id, l.slug, l.label, l.recipient_name, l.recipient_org, v.title AS video_title, l.created_at, l.first_opened_at, l.last_opened_at,
                 l.session_count, l.is_active, l.expires_at
          FROM share_links l JOIN videos v ON v.id = l.video_id WHERE l.deleted_at IS NULL
          ${q.videoId ? sql`AND l.video_id = ${q.videoId}` : sql``} ORDER BY l.created_at`;
      } else {
        rows = await sql`
          SELECT s.id, s.started_at, s.closed_at, l.label AS link_label, l.recipient_name, v.title AS video_title,
                 ${privileged ? sql`host(s.ip)` : sql`NULL`} AS ip, s.ip_trunc::text AS ip_trunc, s.country, s.region, s.city, s.asn,
                 coalesce(i.org_guess, s.as_org) AS org, i.network_type, i.confidence, s.device_type, s.os, s.browser, s.browser_version,
                 s.lang, s.tz, s.referrer_host, s.is_bot, s.bot_name, s.dnt, s.gpc, s.visitor_id, s.visitor_confidence, ss.source,
                 ss.watch_ms, ss.unique_watched_ms, ss.max_position_ms, ss.completion_pct, ss.play_count, ss.seek_count, ss.rebuffer_count,
                 ss.startup_ms, ss.cta_clicks, ss.attachment_downloads, ss.exit_reason
          FROM view_sessions s JOIN share_links l ON l.id = s.link_id JOIN videos v ON v.id = s.video_id
          LEFT JOIN session_summaries ss ON ss.session_id = s.id LEFT JOIN ip_intel i ON i.id = s.ip_intel_id
          WHERE s.started_at >= (${range.from}::date::timestamp AT TIME ZONE ${range.tz})
            AND s.started_at < ((${range.to}::date + 1)::timestamp AT TIME ZONE ${range.tz})
            ${q.videoId ? sql`AND s.video_id = ${q.videoId}` : sql``} ${q.linkId ? sql`AND s.link_id = ${q.linkId}` : sql``}
          ORDER BY s.started_at LIMIT 100000`;
      }
      if (req.admin!.kind === 'user') {
        await audit(sql, {
          actorUserId: req.admin!.userId,
          action: 'telemetry.export',
          diff: { view: q.view, format: q.format, from: range.from, to: range.to },
          ip: req.clientIp,
        });
      }
      const name = `video-share-${q.view}-${range.from}_${range.to}.${q.format}`;
      reply.header('content-disposition', `attachment; filename="${name}"`);
      if (q.format === 'json') return reply.type('application/json').send(rows);
      return reply.type('text/csv; charset=utf-8').send(toCsv(rows));
    },
  );

  // ---- visitors (returning viewers)
  const editor = { preValidation: requireRole('editor') };
  app.get(
    '/visitors',
    {
      schema: {
        querystring: sessionFilterQuery.pick({ page: true, pageSize: true, q: true, sort: true, dir: true }),
      },
      config: tokenOk,
    },
    async (req) => {
      const q = req.query;
      const { col, dir } = orderBy(
        q,
        { lastSeen: 'v.last_seen_at', sessions: 'v.session_count', links: 'v.link_count', label: 'v.label' },
        'lastSeen',
      );
      const where = sql`WHERE v.merged_into IS NULL AND v.session_count > 0 ${q.q ? sql`AND v.label ILIKE ${'%' + q.q + '%'}` : sql``}`;
      const items = await sql`
      SELECT v.id, v.label, v.first_seen_at AS "firstSeenAt", v.last_seen_at AS "lastSeenAt", v.session_count AS sessions, v.link_count AS links,
             (SELECT string_agg(DISTINCT l.label, ', ') FROM view_sessions s JOIN share_links l ON l.id = s.link_id WHERE s.visitor_id = v.id) AS "linkLabels",
             (SELECT coalesce(i.org_guess, s.as_org) FROM view_sessions s LEFT JOIN ip_intel i ON i.id = s.ip_intel_id WHERE s.visitor_id = v.id ORDER BY s.started_at DESC LIMIT 1) AS org
      FROM visitors v ${where} ORDER BY ${sql.unsafe(col)} ${sql.unsafe(dir)} NULLS LAST LIMIT ${q.pageSize} OFFSET ${offset(q)}`;
      const total = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM visitors v ${where}`;
      return { items, total: total[0]!.n, page: q.page, pageSize: q.pageSize };
    },
  );
  app.get('/visitors/:id', { schema: { params: idParams }, config: tokenOk }, async (req) => {
    const v =
      await sql`SELECT id, label, first_seen_at AS "firstSeenAt", last_seen_at AS "lastSeenAt", session_count AS sessions, link_count AS links, merged_into AS "mergedInto"
                        FROM visitors WHERE id = ${req.params.id}`;
    if (!v[0]) throw notFound('visitor');
    const sessions = await sql`
      SELECT s.id, s.started_at AS "startedAt", l.id AS "linkId", l.label AS "linkLabel", v.title AS "videoTitle", s.city, s.country, s.device_type AS device,
             s.browser, coalesce(i.org_guess, s.as_org) AS org, i.network_type AS "networkType", ss.completion_pct AS "completionPct",
             s.visitor_confidence AS confidence
      FROM view_sessions s JOIN share_links l ON l.id = s.link_id JOIN videos v ON v.id = s.video_id
      LEFT JOIN session_summaries ss ON ss.session_id = s.id LEFT JOIN ip_intel i ON i.id = s.ip_intel_id
      WHERE s.visitor_id = ${req.params.id} ORDER BY s.started_at DESC LIMIT 500`;
    return { ...v[0], sessionsList: sessions };
  });
  app.patch(
    '/visitors/:id',
    { ...editor, schema: { params: idParams, body: visitorPatchSchema } },
    async (req) => {
      const r =
        await sql`UPDATE visitors SET label = ${req.body.label ?? null} WHERE id = ${req.params.id} RETURNING id`;
      if (!r.length) throw notFound('visitor');
      await audit(sql, {
        actorUserId: req.admin!.userId,
        action: 'visitor.label',
        entity: 'visitor',
        entityId: req.params.id,
        diff: req.body,
        ip: req.clientIp,
      });
      return { ok: true };
    },
  );
  app.post(
    '/visitors/:id/merge',
    { ...editor, schema: { params: idParams, body: visitorMergeSchema } },
    async (req) => {
      if (req.params.id === req.body.intoId) throw badRequest('cannot merge a visitor into itself');
      await sql.begin(async (tx) => {
        await tx`UPDATE view_sessions SET visitor_id = ${req.body.intoId}, visitor_confidence = 'exact' WHERE visitor_id = ${req.params.id}`;
        await tx`UPDATE browser_fingerprints SET visitor_id = ${req.body.intoId} WHERE visitor_id = ${req.params.id}`;
        await tx`UPDATE visitors SET merged_into = ${req.body.intoId}, session_count = 0, link_count = 0 WHERE id = ${req.params.id}`;
        await refreshVisitor(tx as unknown as Sql, req.body.intoId);
      });
      await audit(sql, {
        actorUserId: req.admin!.userId,
        action: 'visitor.merge',
        entity: 'visitor',
        entityId: req.params.id,
        diff: { into: req.body.intoId },
        ip: req.clientIp,
      });
      return { ok: true };
    },
  );
  /** Detaches a wrongly matched session into a new visitor of its own. */
  app.post(
    '/analytics/sessions/:id/detach-visitor',
    { ...editor, schema: { params: idParams } },
    async (req) => {
      const s = await sql<
        { visitor_id: string | null; fingerprint_id: string | null }[]
      >`SELECT visitor_id, fingerprint_id FROM view_sessions WHERE id = ${req.params.id}`;
      if (!s[0]?.visitor_id) throw notFound('session visitor');
      const id = newId();
      await sql.begin(async (tx) => {
        await tx`INSERT INTO visitors (id) VALUES (${id})`;
        await tx`UPDATE view_sessions SET visitor_id = ${id}, visitor_confidence = 'exact' WHERE id = ${req.params.id}`;
        if (s[0]!.fingerprint_id)
          await tx`UPDATE browser_fingerprints SET visitor_id = ${id} WHERE id = ${s[0]!.fingerprint_id}`;
        await refreshVisitor(tx as unknown as Sql, id);
        await refreshVisitor(tx as unknown as Sql, s[0]!.visitor_id!);
      });
      await audit(sql, {
        actorUserId: req.admin!.userId,
        action: 'visitor.detach',
        entity: 'view_session',
        entityId: req.params.id,
        diff: { from: s[0].visitor_id, to: id },
        ip: req.clientIp,
      });
      return { visitorId: id };
    },
  );
}

async function refreshVisitor(sql: Sql, id: string) {
  await sql`
    UPDATE visitors v SET session_count = x.sessions, link_count = x.links, first_seen_at = coalesce(x.first, v.first_seen_at), last_seen_at = coalesce(x.last, v.last_seen_at)
    FROM (SELECT count(*)::int AS sessions, count(DISTINCT link_id)::int AS links, min(started_at) AS first, max(last_seen_at) AS last
          FROM view_sessions WHERE visitor_id = ${id}) x WHERE v.id = ${id}`;
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]!);
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return '';
    let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    // Neutralise spreadsheet formula injection.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `\uFEFF${cols.join(',')}\r\n${rows.map((r) => cols.map((c) => cell(r[c])).join(',')).join('\r\n')}\r\n`;
}
