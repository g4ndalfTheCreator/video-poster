import type { FastifyRequest } from 'fastify';
import { getSettings, ipInCidrs, newId, truncateIp, type Sql } from '@vs/core';
import type { TelemetryLevel } from '@vs/shared';
import type { AppContext } from '../context.js';
import { parseUa, primaryLang, referrerHost, utmFrom, visitorHash, detectBot } from './viewer.js';

export interface SessionLink {
  id: string;
  video_id: string;
}

export interface CreatedSession {
  id: string;
  /** false when the visitor is on the blocklist: an ephemeral id that is never stored. */
  stored: boolean;
  level: TelemetryLevel;
}

const header = (req: FastifyRequest, name: string) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v.join(',') : v;
};

/**
 * Creates the server-side view session for a page load. The `ip_enrich` job and the client SDK
 * add detail later. Respects the telemetry level and the IP blocklist.
 */
export async function createViewSession(ctx: AppContext, req: FastifyRequest, link: SessionLink, opts: { unlocked: boolean; embed: boolean }): Promise<CreatedSession> {
  const sql: Sql = ctx.database.sql;
  const settings = await getSettings(sql);
  const level = settings.telemetry.level;
  const id = newId();
  if (settings.blocklist.length && ipInCidrs(req.clientIp, settings.blocklist)) return { id, stored: false, level };

  const ua = header(req, 'user-agent') ?? '';
  const al = header(req, 'accept-language') ?? '';
  const info = parseUa(ua, req.headers);
  const bot = detectBot(ua);
  const minimal = level === 'minimal';
  const proto = header(req, 'x-client-protocol') ?? `HTTP/${req.raw.httpVersion}`;
  const tls = header(req, 'x-client-tls') || null;
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO view_sessions (id, link_id, video_id, telemetry_level, ip, ip_trunc, visitor_hash, user_agent, device_type, os, browser,
                                 browser_version, lang, referrer_host, utm, is_bot, bot_name, dnt, gpc, http_version, tls_version,
                                 unlocked, embed)
      VALUES (${id}, ${link.id}, ${link.video_id}, ${level}, ${minimal ? null : req.clientIp}, ${truncateIp(req.clientIp)},
              ${minimal ? null : visitorHash(ctx.config.INGEST_SIGNING_KEY, req.clientIp, ua, al, link.id)},
              ${minimal ? null : ua.slice(0, 1000)}, ${info.deviceType}, ${minimal ? null : info.os}, ${minimal ? null : info.browser},
              ${minimal ? null : info.browserVersion}, ${minimal ? null : primaryLang(al)},
              ${minimal ? null : referrerHost(header(req, 'referer'), ctx.config.PUBLIC_HOST)},
              ${minimal ? null : utmFrom(req.query as Record<string, unknown>) ? sql.json(utmFrom(req.query as Record<string, unknown>) as never) : null},
              ${bot.isBot}, ${bot.name}, ${header(req, 'dnt') === '1'}, ${header(req, 'sec-gpc') === '1'},
              ${minimal ? null : proto.slice(0, 16)}, ${minimal ? null : tls?.slice(0, 16) ?? null}, ${opts.unlocked}, ${opts.embed})`;
    await tx`INSERT INTO session_summaries (session_id) VALUES (${id})`;
  });
  return { id, stored: true, level };
}

/** Appends a server-generated event to a session (negative sequence numbers never collide with client seq). */
export async function serverEvent(sql: Sql, sessionId: string, type: string, payload: Record<string, unknown> = {}, positionMs: number | null = null): Promise<void> {
  await sql`
    INSERT INTO events (session_id, seq, type, client_ts, position_ms, payload)
    SELECT ${sessionId}, coalesce(min(seq), 0) - 1, ${type}, NULL, ${positionMs}, ${sql.json(payload as never)}
    FROM events WHERE session_id = ${sessionId} AND seq < 0`;
}
