import { newId, type Sql } from '@vs/core';
import { rebuildAllRollups } from './rollups.js';

export interface SeedOptions {
  sessions: number;
  videos: number;
  linksPerVideo: number;
  days: number;
}

/**
 * Generates synthetic telemetry (videos without media, links, sessions, summaries, events, IP intel,
 * visitors, previews) directly in SQL so 100 000 sessions take seconds. For dashboard development and
 * performance tests only.
 */
export async function seedTelemetry(
  sql: Sql,
  o: SeedOptions,
): Promise<{ videoIds: string[]; linkIds: string[] }> {
  const videoIds: string[] = [];
  const linkIds: string[] = [];
  const titles = ['CV-esittely', 'Portfolio 2026', 'Hakemusvideo: Yritys X', 'Tuote-demo', 'Tervehdys'];
  const orgs = [
    'Yritys X',
    'Acme Oy',
    'Nordic Bank',
    'Rekrytointi Oy',
    'Kunta',
    'Startup Ab',
    'Konsultointi Oy',
  ];
  for (let v = 0; v < o.videos; v++) {
    const id = newId();
    videoIds.push(id);
    await sql`INSERT INTO videos (id, title, description, status, hls_version, duration_ms, width, height)
              VALUES (${id}, ${`${titles[v % titles.length]} #${v + 1}`}, 'Synthetic seed video', 'ready', 1, ${60_000 + v * 30_000}, 1920, 1080)`;
    for (let l = 0; l < o.linksPerVideo; l++) {
      const lid = newId();
      linkIds.push(lid);
      const org = orgs[(v * o.linksPerVideo + l) % orgs.length]!;
      await sql`INSERT INTO share_links (id, video_id, slug, label, recipient_name, recipient_org)
                VALUES (${lid}, ${id}, ${`seed${lid.replace(/-/g, '').slice(-16)}`}, ${`${org} / rekrytoija ${l + 1}`}, ${`Henkilö ${l + 1}`}, ${org})`;
    }
  }
  // IP intel pool
  await sql`
    INSERT INTO ip_intel (ip, prefix, asn, as_org, network_type, org_guess, confidence, country, city, expires_at)
    SELECT ('198.51.' || (i / 250) || '.' || (i % 250 + 1))::inet, NULL, (ARRAY[719, 1759, 16086, 3301, 8075, 53813])[1 + i % 6],
           (ARRAY['Elisa Oyj', 'Telia Finland', 'DNA Oyj', 'Telia Sverige', 'Microsoft', 'Zscaler'])[1 + i % 6],
           (ARRAY['residential_isp', 'mobile', 'residential_isp', 'business_isp', 'corporate', 'security_proxy'])[1 + i % 6],
           (ARRAY['Elisa Oyj, Helsinki', 'Telia Finland, Tampere', 'DNA Oyj, Oulu', 'Telia Sverige', 'Acme Oy', 'Zscaler (yritysverkko)'])[1 + i % 6],
           (ARRAY['low', 'low', 'low', 'low', 'high', 'medium'])[1 + i % 6],
           (ARRAY['FI', 'FI', 'FI', 'SE', 'FI', 'DE'])[1 + i % 6], (ARRAY['Helsinki', 'Tampere', 'Oulu', 'Stockholm', 'Espoo', 'Frankfurt'])[1 + i % 6],
           now() + interval '30 days'
    FROM generate_series(0, 1999) i`;
  // visitors pool (~1 visitor per 3 sessions)
  const visitorCount = Math.max(1, Math.floor(o.sessions / 3));
  await sql`INSERT INTO visitors (id, session_count, link_count) SELECT uuid_generate_v7(), 0, 0 FROM generate_series(1, ${visitorCount})`;
  await sql`
    CREATE TEMP TABLE seed_links AS SELECT row_number() OVER () - 1 AS n, l.id, l.video_id, v.duration_ms FROM share_links l JOIN videos v ON v.id = l.video_id
    WHERE l.id = ANY(${linkIds})`;
  await sql`CREATE TEMP TABLE seed_intel AS SELECT row_number() OVER () - 1 AS n, id, ip, asn, as_org, country, city FROM ip_intel`;
  await sql`CREATE TEMP TABLE seed_visitors AS SELECT row_number() OVER () - 1 AS n, id FROM visitors`;
  const nLinks = linkIds.length;
  await sql`
    CREATE TEMP TABLE seed_sessions AS
    SELECT uuid_generate_v7() AS id, sl.id AS link_id, sl.video_id, sl.duration_ms,
           now() - (random() * ${o.days} * interval '1 day') AS started_at, si.ip, si.id AS intel_id, si.asn, si.as_org, si.country, si.city,
           sv.id AS visitor_id, random() < 0.03 AS is_bot,
           (ARRAY['desktop', 'desktop', 'mobile', 'mobile', 'tablet'])[1 + (g % 5)] AS device,
           (ARRAY['Chrome', 'Safari', 'Firefox', 'Edge', 'Chrome'])[1 + (g % 5)] AS browser,
           (ARRAY[NULL, 'www.linkedin.com', 'teams.microsoft.com', 'mail.google.com', NULL, NULL])[1 + (g % 6)] AS referrer,
           power(random(), 0.7) AS watched
    FROM generate_series(1, ${o.sessions}) g
    JOIN seed_links sl ON sl.n = g % ${nLinks}
    JOIN seed_intel si ON si.n = (g * 7) % 2000
    JOIN seed_visitors sv ON sv.n = (g * 13) % ${visitorCount}`;
  await sql`
    INSERT INTO view_sessions (id, link_id, video_id, visitor_id, visitor_confidence, started_at, last_seen_at, closed_at, ip, ip_trunc, ip_intel_id,
                               visitor_hash, country, city, asn, as_org, device_type, browser, os, lang, referrer_host, is_bot, has_client_telemetry)
    SELECT id, link_id, video_id, visitor_id, 'exact', started_at, started_at + interval '3 minutes', started_at + interval '3 minutes', ip,
           network(set_masklen(ip, 24))::inet, intel_id, md5(id::text), country, city, asn, as_org, device, browser, 'Windows', 'fi-FI', referrer, is_bot, true
    FROM seed_sessions`;
  await sql`
    INSERT INTO session_summaries (session_id, source, watch_ms, unique_watched_ms, max_position_ms, completion_pct, play_count, seek_count,
                                   startup_ms, ttff_ms, quartiles, played_ranges, raw_ranges, renditions, ended, cta_clicks, rebuffer_ms, rebuffer_count)
    SELECT id, 'client', (watched * duration_ms * 1.1)::bigint, (watched * duration_ms)::bigint, (watched * duration_ms)::int, round((watched * 100)::numeric, 2),
           CASE WHEN watched > 0.02 THEN 1 ELSE 0 END, (random() * 2)::int, (200 + random() * 800)::int, (100 + random() * 600)::int,
           array_remove(ARRAY[CASE WHEN watched >= 0.25 THEN 25 END, CASE WHEN watched >= 0.5 THEN 50 END, CASE WHEN watched >= 0.75 THEN 75 END, CASE WHEN watched >= 0.95 THEN 100 END], NULL),
           jsonb_build_array(jsonb_build_array(0, (watched * duration_ms)::int)),
           jsonb_build_array(jsonb_build_array(0, (watched * duration_ms)::int), jsonb_build_array(0, (watched * duration_ms * 0.1)::int)),
           jsonb_build_object('1080', (watched * duration_ms * 0.7)::int, '720', (watched * duration_ms * 0.3)::int),
           watched > 0.97, CASE WHEN random() < 0.1 THEN 1 ELSE 0 END, (random() * 300)::int, (random() * 2)::int
    FROM seed_sessions`;
  await sql`
    INSERT INTO events (session_id, seq, type, client_ts, server_ts, position_ms, payload)
    SELECT id, 0, 'page_view', started_at, started_at, 0, '{}'::jsonb FROM seed_sessions
    UNION ALL SELECT id, 1, 'play', started_at, started_at, 0, '{"source":"user"}'::jsonb FROM seed_sessions WHERE watched > 0.02`;
  await sql`
    INSERT INTO link_previews (link_id, fetched_at, bot_name, ip, country)
    SELECT link_id, started_at - interval '1 minute', (ARRAY['LinkedInBot', 'Slackbot', 'Microsoft Teams'])[1 + (row_number() OVER () % 3)::int], ip, country
    FROM seed_sessions WHERE random() < 0.05`;
  await sql`
    UPDATE share_links l SET session_count = x.n, first_opened_at = x.first, last_opened_at = x.last
    FROM (SELECT link_id, count(*)::int AS n, min(started_at) AS first, max(started_at) AS last FROM seed_sessions WHERE NOT is_bot GROUP BY 1) x
    WHERE l.id = x.link_id`;
  await sql`
    UPDATE visitors v SET session_count = x.n, link_count = x.l, first_seen_at = x.f, last_seen_at = x.m
    FROM (SELECT visitor_id, count(*)::int AS n, count(DISTINCT link_id)::int AS l, min(started_at) AS f, max(started_at) AS m FROM seed_sessions GROUP BY 1) x
    WHERE v.id = x.visitor_id`;
  await sql`DROP TABLE seed_sessions, seed_links, seed_intel, seed_visitors`;
  await sql`SELECT ensure_month_partitions('events', 3, ${Math.ceil(o.days / 30) + 1})`;
  await rebuildAllRollups(sql);
  await sql`ANALYZE`;
  return { videoIds, linkIds };
}
