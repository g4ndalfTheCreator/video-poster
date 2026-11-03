import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { audit } from '@vs/core';
import { idParams, roleAtLeastFn } from '@vs/shared';
import type { AppContext } from '../../context.js';
import { notFound } from '../../lib/errors.js';

/** Raw IP, PTR and browser-profile signals are visible to owner/editor only. */
export const canSeeIdentifiers = (role: string) => roleAtLeastFn(role, 'editor');

export async function analyticsRoutes(fastify: FastifyInstance, ctx: AppContext) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const sql = ctx.database.sql;

  app.get(
    '/analytics/sessions/:id',
    { schema: { params: idParams }, config: { allowApiToken: true } },
    async (req) => {
      const rows = await sql<Record<string, unknown>[]>`
      SELECT s.*, host(s.ip) AS ip_text, s.ip_trunc::text AS ip_trunc_text, l.label AS link_label, l.slug, l.recipient_name, l.recipient_org,
             v.title AS video_title, v.duration_ms, i.network_type, i.org_guess, i.confidence, i.ptr, i.ptr_confirmed, i.rdap_org, i.rdap_netname,
             i.rdap_cidr, i.as_org AS intel_as_org, i.asn AS intel_asn, i.abuse_email, vis.label AS visitor_label, vis.session_count AS visitor_sessions,
             vis.link_count AS visitor_links, ss.*
      FROM view_sessions s JOIN share_links l ON l.id = s.link_id JOIN videos v ON v.id = s.video_id
      LEFT JOIN ip_intel i ON i.id = s.ip_intel_id LEFT JOIN visitors vis ON vis.id = s.visitor_id
      LEFT JOIN session_summaries ss ON ss.session_id = s.id
      WHERE s.id = ${req.params.id}`;
      const s = rows[0];
      if (!s) throw notFound('session');
      const privileged = canSeeIdentifiers(req.admin!.role);
      const [events, fetches, fp] = await Promise.all([
        sql`SELECT seq, type, client_ts AS "clientTs", server_ts AS "serverTs", position_ms AS "positionMs", payload FROM events
          WHERE session_id = ${req.params.id} ORDER BY server_ts, seq LIMIT 5000`,
        sql`SELECT ts, rendition, segment_index AS "segmentIndex", status, bytes, request_time_ms AS "requestTimeMs" FROM segment_fetches
          WHERE session_id = ${req.params.id} ORDER BY ts LIMIT 5000`,
        privileged && s.fingerprint_id
          ? sql`SELECT fp_hash AS "fpHash", randomized, signals, seen_count AS "seenCount" FROM browser_fingerprints WHERE id = ${s.fingerprint_id as string}`
          : Promise.resolve([]),
      ]);
      if (privileged && req.admin!.kind === 'user') {
        await audit(sql, {
          actorUserId: req.admin!.userId,
          action: 'telemetry.session_view',
          entity: 'view_session',
          entityId: req.params.id,
          ip: req.clientIp,
        });
      }
      return {
        id: s.id,
        linkId: s.link_id,
        videoId: s.video_id,
        linkLabel: s.link_label,
        slug: s.slug,
        recipientName: s.recipient_name,
        recipientOrg: s.recipient_org,
        videoTitle: s.video_title,
        durationMs: s.duration_ms,
        startedAt: s.started_at,
        lastSeenAt: s.last_seen_at,
        closedAt: s.closed_at,
        telemetryLevel: s.telemetry_level,
        ip: privileged ? s.ip_text : null,
        ipTrunc: s.ip_trunc_text,
        country: s.country,
        region: s.region,
        city: s.city,
        asn: s.asn ?? s.intel_asn,
        asOrg: s.as_org ?? s.intel_as_org,
        network: {
          type: s.network_type,
          orgGuess: s.org_guess,
          confidence: s.confidence,
          ptr: privileged ? s.ptr : null,
          ptrConfirmed: privileged ? s.ptr_confirmed : null,
          rdapOrg: s.rdap_org,
          rdapNetname: s.rdap_netname,
          rdapCidr: privileged ? s.rdap_cidr : null,
          abuseEmail: privileged ? s.abuse_email : null,
        },
        device: {
          type: s.device_type,
          os: s.os,
          browser: s.browser,
          browserVersion: s.browser_version,
          screen: s.screen_w ? [s.screen_w, s.screen_h] : null,
          lang: s.lang,
          tz: s.tz,
        },
        referrerHost: s.referrer_host,
        utm: s.utm,
        isBot: s.is_bot,
        botName: s.bot_name,
        dnt: s.dnt,
        gpc: s.gpc,
        httpVersion: s.http_version,
        tlsVersion: s.tls_version,
        visitor: s.visitor_id
          ? {
              id: s.visitor_id,
              label: s.visitor_label,
              confidence: s.visitor_confidence,
              sessions: s.visitor_sessions,
              links: s.visitor_links,
            }
          : null,
        hasClientTelemetry: s.has_client_telemetry,
        summary: {
          source: s.source,
          watchMs: s.watch_ms,
          uniqueWatchedMs: s.unique_watched_ms,
          maxPositionMs: s.max_position_ms,
          completionPct: s.completion_pct,
          playCount: s.play_count,
          seekCount: s.seek_count,
          rebufferCount: s.rebuffer_count,
          rebufferMs: s.rebuffer_ms,
          startupMs: s.startup_ms,
          ttffMs: s.ttff_ms,
          qualitySwitches: s.quality_switches,
          ended: s.ended,
          quartiles: s.quartiles,
          playedRanges: s.played_ranges,
          rawRanges: s.raw_ranges,
          serverPlayedRanges: s.server_played_ranges,
          serverUniqueWatchedMs: s.server_unique_watched_ms,
          renditions: s.renditions,
          errors: s.errors,
          ctaClicks: s.cta_clicks,
          attachmentDownloads: s.attachment_downloads,
          videoDownloads: s.video_downloads,
          exitReason: s.exit_reason,
        },
        fingerprint: fp[0] ?? null,
        events,
        segmentFetches: fetches,
      };
    },
  );
}
