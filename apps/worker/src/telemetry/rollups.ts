import { getSettings, type Sql } from '@vs/core';
import {
  bucketPlayCounts,
  coveredBuckets,
  RETENTION_BUCKETS,
  VIEW_MIN_WATCHED_MS,
  type Range,
} from '@vs/shared';

/**
 * Recomputes daily_rollups for [from, to] (dates in the configured UI time zone). Idempotent: rows
 * of the range are replaced. Bots are excluded from all counts except bot_sessions.
 */
export async function computeDailyRollups(
  sql: Sql,
  from: string,
  to: string,
  videoId?: string,
): Promise<number> {
  const tz = (await getSettings(sql)).ui.timezone;
  return sql.begin(async (tx) => {
    await tx`DELETE FROM daily_rollups WHERE date BETWEEN ${from}::date AND ${to}::date ${videoId ? tx`AND video_id = ${videoId}` : tx``}`;
    const rows = await tx`
      WITH s AS (
        SELECT vs.id, vs.video_id, vs.link_id, (vs.started_at AT TIME ZONE ${tz})::date AS date, vs.is_bot,
               coalesce(vs.visitor_id::text, vs.visitor_hash, vs.id::text) AS visitor_key,
               coalesce(vs.country, '??') AS country, coalesce(vs.device_type, 'unknown') AS device,
               coalesce(vs.referrer_host, '(direct)') AS referrer, coalesce(i.network_type, 'unknown') AS network_type,
               coalesce(i.org_guess, vs.as_org, 'unknown') AS org,
               coalesce(ss.watch_ms, 0) AS watch_ms, coalesce(ss.unique_watched_ms, 0) AS unique_watched_ms,
               coalesce(ss.completion_pct, 0) AS completion_pct, coalesce(ss.play_count, 0) AS play_count,
               coalesce(ss.cta_clicks, 0) AS cta_clicks, coalesce(ss.attachment_downloads, 0) AS attachment_downloads
        FROM view_sessions vs
        LEFT JOIN session_summaries ss ON ss.session_id = vs.id
        LEFT JOIN ip_intel i ON i.id = vs.ip_intel_id
        WHERE vs.started_at >= (${from}::date::timestamp AT TIME ZONE ${tz})
          AND vs.started_at < ((${to}::date + 1)::timestamp AT TIME ZONE ${tz})
          ${videoId ? tx`AND vs.video_id = ${videoId}` : tx``}
      ),
      h AS (SELECT * FROM s WHERE NOT is_bot),
      dim_counts AS (
        SELECT date, link_id, 'c' AS dim, country AS k, count(*) AS n FROM h GROUP BY 1, 2, 4
        UNION ALL SELECT date, link_id, 'd', device, count(*) FROM h GROUP BY 1, 2, 4
        UNION ALL SELECT date, link_id, 'r', referrer, count(*) FROM h GROUP BY 1, 2, 4
        UNION ALL SELECT date, link_id, 'n', network_type, count(*) FROM h GROUP BY 1, 2, 4
        UNION ALL SELECT date, link_id, 'o', org, count(*) FROM h GROUP BY 1, 2, 4
      ),
      dims AS (
        SELECT date, link_id,
          coalesce(jsonb_object_agg(k, n) FILTER (WHERE dim = 'c'), '{}') AS by_country,
          coalesce(jsonb_object_agg(k, n) FILTER (WHERE dim = 'd'), '{}') AS by_device,
          coalesce(jsonb_object_agg(k, n) FILTER (WHERE dim = 'r'), '{}') AS by_referrer,
          coalesce(jsonb_object_agg(k, n) FILTER (WHERE dim = 'n'), '{}') AS by_network_type,
          coalesce(jsonb_object_agg(k, n) FILTER (WHERE dim = 'o'), '{}') AS by_org
        FROM dim_counts GROUP BY 1, 2
      ),
      agg AS (
        SELECT date, video_id, link_id,
          count(*) FILTER (WHERE NOT is_bot)::int AS sessions,
          count(DISTINCT visitor_key) FILTER (WHERE NOT is_bot)::int AS unique_visitors,
          count(*) FILTER (WHERE NOT is_bot AND play_count > 0)::int AS plays,
          count(*) FILTER (WHERE NOT is_bot AND unique_watched_ms >= ${VIEW_MIN_WATCHED_MS})::int AS views,
          coalesce(sum(watch_ms) FILTER (WHERE NOT is_bot), 0)::bigint AS watch_ms,
          coalesce(sum(unique_watched_ms) FILTER (WHERE NOT is_bot), 0)::bigint AS unique_watched_ms,
          count(*) FILTER (WHERE NOT is_bot AND unique_watched_ms >= ${VIEW_MIN_WATCHED_MS} AND completion_pct >= 95)::int AS completions,
          coalesce(round(avg(completion_pct) FILTER (WHERE NOT is_bot AND unique_watched_ms >= ${VIEW_MIN_WATCHED_MS}), 2), 0) AS avg_completion_pct,
          count(*) FILTER (WHERE is_bot)::int AS bot_sessions,
          coalesce(sum(cta_clicks) FILTER (WHERE NOT is_bot), 0)::int AS cta_clicks,
          coalesce(sum(attachment_downloads) FILTER (WHERE NOT is_bot), 0)::int AS attachment_downloads
        FROM s GROUP BY 1, 2, 3
      ),
      previews AS (
        SELECT (p.fetched_at AT TIME ZONE ${tz})::date AS date, l.video_id, p.link_id, count(*)::int AS n
        FROM link_previews p JOIN share_links l ON l.id = p.link_id
        WHERE p.fetched_at >= (${from}::date::timestamp AT TIME ZONE ${tz}) AND p.fetched_at < ((${to}::date + 1)::timestamp AT TIME ZONE ${tz})
          ${videoId ? tx`AND l.video_id = ${videoId}` : tx``}
        GROUP BY 1, 2, 3
      ),
      keys AS (SELECT date, video_id, link_id FROM agg UNION SELECT date, video_id, link_id FROM previews)
      INSERT INTO daily_rollups (date, video_id, link_id, sessions, unique_visitors, plays, views, watch_ms, unique_watched_ms, completions,
                                 avg_completion_pct, bot_sessions, previews, cta_clicks, attachment_downloads, by_country, by_device,
                                 by_referrer, by_network_type, by_org, computed_at)
      SELECT k.date, k.video_id, k.link_id, coalesce(a.sessions, 0), coalesce(a.unique_visitors, 0), coalesce(a.plays, 0), coalesce(a.views, 0),
             coalesce(a.watch_ms, 0), coalesce(a.unique_watched_ms, 0), coalesce(a.completions, 0), coalesce(a.avg_completion_pct, 0),
             coalesce(a.bot_sessions, 0), coalesce(p.n, 0), coalesce(a.cta_clicks, 0), coalesce(a.attachment_downloads, 0),
             coalesce(d.by_country, '{}'), coalesce(d.by_device, '{}'), coalesce(d.by_referrer, '{}'), coalesce(d.by_network_type, '{}'),
             coalesce(d.by_org, '{}'), now()
      FROM keys k
      LEFT JOIN agg a USING (date, video_id, link_id)
      LEFT JOIN dims d USING (date, link_id)
      LEFT JOIN previews p USING (date, video_id, link_id)
      RETURNING 1`;
    return rows.length;
  });
}

/** Recomputes all-time retention buckets (1 % each) and rewatch counts for one link. */
export async function computeRetention(sql: Sql, linkId: string): Promise<void> {
  const rows = await sql<
    { video_id: string; duration_ms: number | null; played_ranges: Range[]; raw_ranges: Range[] }[]
  >`
    SELECT vs.video_id, v.duration_ms, ss.played_ranges, ss.raw_ranges
    FROM view_sessions vs JOIN session_summaries ss ON ss.session_id = vs.id JOIN videos v ON v.id = vs.video_id
    WHERE vs.link_id = ${linkId} AND NOT vs.is_bot AND ss.unique_watched_ms >= ${VIEW_MIN_WATCHED_MS}`;
  const link = await sql<{ video_id: string; duration_ms: number | null }[]>`
    SELECT l.video_id, v.duration_ms FROM share_links l JOIN videos v ON v.id = l.video_id WHERE l.id = ${linkId}`;
  if (!link[0]) return;
  const dur = link[0].duration_ms ?? 0;
  const viewers = new Array<number>(RETENTION_BUCKETS).fill(0);
  const rewatches = new Array<number>(RETENTION_BUCKETS).fill(0);
  for (const r of rows) {
    coveredBuckets(r.played_ranges, dur, RETENTION_BUCKETS).forEach((c, i) => c && viewers[i]!++);
    bucketPlayCounts(r.raw_ranges, dur, RETENTION_BUCKETS).forEach((n, i) => n > 1 && rewatches[i]!++);
  }
  await sql.begin(async (tx) => {
    await tx`DELETE FROM retention_buckets WHERE link_id = ${linkId}`;
    if (!rows.length) return;
    const data = viewers.map((v, bucket) => ({
      video_id: link[0]!.video_id,
      link_id: linkId,
      bucket,
      viewers: v,
      rewatches: rewatches[bucket]!,
    }));
    await tx`INSERT INTO retention_buckets ${tx(data as never, 'video_id', 'link_id', 'bucket', 'viewers', 'rewatches')}`;
  });
}

let lastRun: Date | null = null;

/**
 * Incremental rollups (every 5 min): today and yesterday, and retention for links with recent activity.
 * Nightly: full recomputation of the previous day (`full`).
 */
export async function runRollups(
  sql: Sql,
  opts: { full?: boolean; videoId?: string } = {},
): Promise<{ days: number; links: number }> {
  const tz = (await getSettings(sql)).ui.timezone;
  const today = (await sql<{ d: string }[]>`SELECT (now() AT TIME ZONE ${tz})::date::text AS d`)[0]!.d;
  const yesterday = (await sql<{ d: string }[]>`SELECT ((now() AT TIME ZONE ${tz})::date - 1)::text AS d`)[0]!
    .d;
  let days = 0;
  if (opts.videoId) {
    const range = await sql<{ a: string | null; b: string | null }[]>`
      SELECT min((started_at AT TIME ZONE ${tz})::date)::text AS a, max((started_at AT TIME ZONE ${tz})::date)::text AS b
      FROM view_sessions WHERE video_id = ${opts.videoId}`;
    await sql`DELETE FROM daily_rollups WHERE video_id = ${opts.videoId}`;
    if (range[0]?.a) days = await computeDailyRollups(sql, range[0].a, range[0].b!, opts.videoId);
  } else {
    days = await computeDailyRollups(sql, opts.full ? yesterday : yesterday, today);
  }
  const since = opts.full || opts.videoId ? new Date(0) : (lastRun ?? new Date(Date.now() - 24 * 3600_000));
  lastRun = new Date();
  const links = await sql<{ link_id: string }[]>`
    SELECT DISTINCT vs.link_id FROM view_sessions vs JOIN session_summaries ss ON ss.session_id = vs.id
    WHERE ss.updated_at >= ${since} ${opts.videoId ? sql`AND vs.video_id = ${opts.videoId}` : sql``}`;
  for (const l of links) await computeRetention(sql, l.link_id);
  return { days, links: links.length };
}

/** Backfills rollups for every day that has sessions (used by the seeder and after GDPR deletions). */
export async function rebuildAllRollups(sql: Sql): Promise<void> {
  const tz = (await getSettings(sql)).ui.timezone;
  const r = await sql<{ a: string | null; b: string | null }[]>`
    SELECT min((started_at AT TIME ZONE ${tz})::date)::text AS a, greatest(max((started_at AT TIME ZONE ${tz})::date), (now() AT TIME ZONE ${tz})::date)::text AS b
    FROM view_sessions`;
  await sql`DELETE FROM daily_rollups`;
  if (r[0]?.a) await computeDailyRollups(sql, r[0].a, r[0].b!);
  const links = await sql<{ id: string }[]>`SELECT id FROM share_links`;
  for (const l of links) await computeRetention(sql, l.id);
}
