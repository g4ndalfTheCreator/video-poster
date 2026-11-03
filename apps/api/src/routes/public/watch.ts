import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createIngestToken,
  getSettings,
  hitRateLimit,
  hmacBase64Url,
  PREVIEW_SESSION,
  safeEqual,
  sessionSig,
  signMediaUrl,
  verifyIngestToken,
  verifySessionSig,
  type Sql,
} from '@vs/core';
import { ANY_SLUG_RE, type Cta, type Settings } from '@vs/shared';
import type { AppContext } from '../../context.js';
import { pickLang, publicStrings, DEFAULT_PRIVACY, type Lang } from '../../i18n/public.js';
import { newNonce, setPageHeaders } from '../../public/headers.js';
import { notFoundPage, passwordPage, privacyPage, watchPage } from '../../public/templates.js';
import { verifyPassword, dummyVerify } from '../../lib/password.js';
import { createViewSession, serverEvent } from '../../lib/sessions.js';
import { detectBot } from '../../lib/viewer.js';
import { effectiveCtas } from '../../lib/links.js';
import { sendMediaFile } from '../../lib/files.js';
import { notFound, forbidden } from '../../lib/errors.js';

const MIN_RESPONSE_MS = 150;
const UNLOCK_TTL_S = 12 * 3600;
const OG_TTL_S = 30 * 24 * 3600;

interface ResolvedLink {
  id: string;
  slug: string;
  video_id: string;
  password_hash: string | null;
  expires_at: Date | null;
  max_sessions: number | null;
  session_count: number;
  is_active: boolean;
  allow_download: boolean;
  allow_embed: boolean;
  cta_config: Cta[] | null;
  label: string;
  title: string;
  description: string;
  status: string;
  hls_version: number;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  autoplay_muted: boolean;
  video_cta: Cta[];
}

type Resolution =
  | { kind: 'ok'; link: ResolvedLink }
  | { kind: 'redirect'; slug: string }
  | { kind: 'gone'; linkId?: string; reason: string };

async function resolveSlug(sql: Sql, slug: string): Promise<Resolution> {
  if (!ANY_SLUG_RE.test(slug)) return { kind: 'gone', reason: 'format' };
  const rows = await sql<ResolvedLink[]>`
    SELECT l.id, l.slug, l.video_id, l.password_hash, l.expires_at, l.max_sessions, l.session_count, l.is_active, l.allow_download,
           l.allow_embed, l.cta_config, l.label, v.title, v.description, v.status, v.hls_version, v.duration_ms, v.width, v.height,
           v.autoplay_muted, v.cta_config AS video_cta
    FROM share_links l JOIN videos v ON v.id = l.video_id
    WHERE l.slug = ${slug} AND l.deleted_at IS NULL AND v.deleted_at IS NULL`;
  const link = rows[0];
  if (!link) {
    const r = await sql<{ slug: string }[]>`
      SELECT l.slug FROM share_link_redirects r JOIN share_links l ON l.id = r.link_id
      WHERE r.slug = ${slug} AND l.deleted_at IS NULL`;
    return r[0] ? { kind: 'redirect', slug: r[0].slug } : { kind: 'gone', reason: 'unknown' };
  }
  if (!link.is_active) return { kind: 'gone', linkId: link.id, reason: 'closed' };
  if (link.expires_at && link.expires_at.getTime() <= Date.now())
    return { kind: 'gone', linkId: link.id, reason: 'expired' };
  if (link.status !== 'ready' || !link.hls_version)
    return { kind: 'gone', linkId: link.id, reason: 'not_ready' };
  return { kind: 'ok', link };
}

const unlockCookieName = (linkId: string) => `vsu_${linkId.replace(/-/g, '').slice(0, 16)}`;

export async function publicRoutes(app: FastifyInstance, ctx: AppContext) {
  const sql = ctx.database.sql;
  const key = ctx.config.INGEST_SIGNING_KEY;
  const version = ctx.config.BUILD_VERSION;
  const ttl = ctx.config.MEDIA_TOKEN_TTL_S;

  const langOf = (req: FastifyRequest, settings: Settings): Lang =>
    pickLang(
      req.headers['accept-language'],
      (req.query as Record<string, unknown>)?.lang,
      settings.ui.locale,
    );

  /** Uniform response time and body for every "not available" case so link existence cannot be inferred. */
  const sendNotFound = async (req: FastifyRequest, reply: FastifyReply, started: number) => {
    const settings = await getSettings(sql);
    const lang = langOf(req, settings);
    const nonce = newNonce();
    const wait = MIN_RESPONSE_MS - (performance.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    setPageHeaders(reply, ctx.config, { nonce });
    return reply.code(404).send(notFoundPage({ lang, t: publicStrings[lang], nonce, settings, version }));
  };
  const pad = async (started: number) => {
    const wait = MIN_RESPONSE_MS - (performance.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };

  const linkEvent = (linkId: string, type: string, req: FastifyRequest) =>
    sql`INSERT INTO link_events (link_id, type, ip, user_agent) VALUES (${linkId}, ${type}, ${req.clientIp}, ${(req.headers['user-agent'] ?? '').slice(0, 500)})`.catch(
      () => undefined,
    );

  const isUnlocked = (req: FastifyRequest, link: ResolvedLink): boolean => {
    if (!link.password_hash) return true;
    const raw = req.cookies[unlockCookieName(link.id)];
    if (!raw) return false;
    const [exp, sig] = raw.split('.');
    if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
    return safeEqual(sig, hmacBase64Url(key, `unlock:${link.id}:${exp}:${link.password_hash.slice(-16)}`));
  };

  const posterOg = (link: ResolvedLink) =>
    `${ctx.config.publicOrigin}${signMediaUrl({ key: ctx.config.MEDIA_SIGNING_KEY, sessionId: PREVIEW_SESSION, videoId: link.video_id, version: link.hls_version, file: 'poster.jpg', ttlSec: OG_TTL_S })}`;

  const renderWatch = async (req: FastifyRequest, reply: FastifyReply, slug: string, embed: boolean) => {
    const started = performance.now();
    const res = await resolveSlug(sql, slug);
    if (res.kind === 'redirect') {
      await pad(started);
      return reply.redirect(`/${embed ? 'e' : 'v'}/${res.slug}`, 301);
    }
    if (res.kind === 'gone') {
      if (res.linkId && res.reason === 'expired') void linkEvent(res.linkId, 'link_expired_hit', req);
      return sendNotFound(req, reply, started);
    }
    const link = res.link;
    if (embed && !link.allow_embed) return sendNotFound(req, reply, started);
    const settings = await getSettings(sql);
    const lang = langOf(req, settings);
    const t = publicStrings[lang];
    const nonce = newNonce();
    const ua = req.headers['user-agent'];
    const bot = detectBot(ua);
    const description = link.description || '';
    const base = {
      lang,
      t,
      nonce,
      settings,
      version,
      title: link.title,
      description,
      url: `${ctx.config.publicOrigin}/v/${link.slug}`,
      ogImage: posterOg(link),
      width: link.width,
      height: link.height,
      durationMs: link.duration_ms,
      embed,
    };

    // Link preview bots (LinkedIn, Slack, Teams, …): Open Graph page only, recorded as a preview, not a view.
    if (bot.isBot) {
      await sql`INSERT INTO link_previews (link_id, bot_name, user_agent, ip, country) VALUES (${link.id}, ${bot.name}, ${(ua ?? '').slice(0, 500)}, ${req.clientIp}, NULL)`;
      await ctx.jobs.send('ip_enrich', { ip: req.clientIp ?? '' }).catch(() => undefined);
      await pad(started);
      setPageHeaders(reply, ctx.config, { nonce, embed });
      return reply.send(
        watchPage({
          ...base,
          posterUrl: null,
          masterUrl: null,
          attachments: [],
          ctas: [],
          downloadHref: null,
          captions: [],
          config: null,
        }),
      );
    }

    if (!isUnlocked(req, link)) {
      await pad(started);
      setPageHeaders(reply, ctx.config, { nonce, embed });
      return reply.send(
        passwordPage({ lang, t, nonce, settings, version, slug: link.slug, title: link.title }),
      );
    }

    // Atomically count the session against max_sessions (bots never reach this point).
    const counted = await sql`
      UPDATE share_links SET session_count = session_count + 1, last_opened_at = now(), first_opened_at = coalesce(first_opened_at, now())
      WHERE id = ${link.id} AND (max_sessions IS NULL OR session_count < max_sessions) RETURNING id`;
    if (!counted.length) {
      void linkEvent(link.id, 'max_sessions_hit', req);
      return sendNotFound(req, reply, started);
    }
    const session = await createViewSession(ctx, req, link, { unlocked: !!link.password_hash, embed });
    if (session.stored)
      await ctx.jobs
        .send('ip_enrich', { ip: req.clientIp ?? '', sessionId: session.id })
        .catch(() => undefined);

    const sign = (file: string) =>
      signMediaUrl({
        key: ctx.config.MEDIA_SIGNING_KEY,
        sessionId: session.id,
        videoId: link.video_id,
        version: link.hls_version,
        file,
        ttlSec: ttl,
      });
    const sig = (purpose: string) => sessionSig(key, session.id, purpose);
    const [assets, download] = await Promise.all([
      sql<
        {
          id: string;
          kind: string;
          lang: string | null;
          label: string | null;
          filename: string | null;
          size_bytes: number;
        }[]
      >`
        SELECT id, kind, lang, label, filename, size_bytes FROM assets WHERE video_id = ${link.video_id} AND kind IN ('captions', 'attachment')
        ORDER BY created_at`,
      link.allow_download
        ? sql`SELECT 1 FROM assets WHERE video_id = ${link.video_id} AND kind = 'download_mp4' AND hls_version = ${link.hls_version}`
        : Promise.resolve([]),
    ]);
    const fileSig = sig('file');
    const captions = assets
      .filter((a) => a.kind === 'captions')
      .map((a) => ({
        lang: a.lang ?? 'und',
        label: a.label ?? a.lang ?? '',
        src: `/api/public/links/${link.slug}/captions/${a.id}?s=${session.id}&sig=${fileSig}`,
      }));
    const attachments = assets
      .filter((a) => a.kind === 'attachment')
      .map((a) => ({
        id: a.id,
        label: a.label ?? a.filename ?? 'file',
        size: a.size_bytes,
        href: `/api/public/links/${link.slug}/attachments/${a.id}?s=${session.id}&sig=${fileSig}`,
      }));
    const ctaSig = sig('cta');
    const ctas = effectiveCtas(link, { cta_config: link.video_cta }).map((c) => ({
      id: c.id,
      label: c.label,
      href: `/go/${session.id}/${encodeURIComponent(c.id)}/${ctaSig}`,
      host: hostOf(c.href),
    }));
    const downloadHref = download.length
      ? `/api/public/links/${link.slug}/download?s=${session.id}&sig=${fileSig}`
      : null;
    const master = sign('master.m3u8');
    const clientTelemetry = session.stored && session.level === 'full';
    const config = {
      v: 1,
      slug: link.slug,
      sessionId: session.id,
      token: createIngestToken(key, link.id, session.id, link.video_id),
      master,
      spriteVtt: sign('sprite.vtt'),
      durationMs: link.duration_ms,
      autoplayMuted: link.autoplay_muted,
      telemetry: clientTelemetry ? 'full' : 'off',
      playbackUrl: `/api/public/links/${link.slug}/playback`,
      ingestUrl: '/t/v1/events',
      beaconUrl: '/t/v1/beacon',
      tokenExpiresAt: Math.floor(Date.now() / 1000) + ttl,
      ctas: ctas.map((c) => ({ id: c.id, host: c.host })),
      strings: {
        play: t.play,
        pause: t.pause,
        mute: t.mute,
        unmute: t.unmute,
        volume: t.volume,
        seek: t.seek,
        fullscreen: t.fullscreen,
        exitFullscreen: t.exitFullscreen,
        captions: t.captions,
        captionsOff: t.captionsOff,
        quality: t.quality,
        auto: t.auto,
        pip: t.pip,
        error: t.error,
      },
    };
    setPageHeaders(reply, ctx.config, { nonce, embed });
    return reply.send(
      watchPage({
        ...base,
        posterUrl: sign('poster.jpg'),
        masterUrl: master,
        attachments,
        ctas,
        downloadHref,
        captions,
        config,
      }),
    );
  };

  app.get('/v/:slug', async (req, reply) =>
    renderWatch(req, reply, (req.params as { slug: string }).slug, false),
  );
  app.get('/e/:slug', async (req, reply) =>
    renderWatch(req, reply, (req.params as { slug: string }).slug, true),
  );

  app.post('/v/:slug/unlock', async (req, reply) => {
    const started = performance.now();
    const { slug } = req.params as { slug: string };
    const password = String((req.body as Record<string, unknown> | undefined)?.password ?? '').slice(0, 256);
    const res = await resolveSlug(sql, slug);
    if (res.kind !== 'ok' || !res.link.password_hash) {
      await dummyVerify(password);
      return sendNotFound(req, reply, started);
    }
    const link = res.link;
    const settings = await getSettings(sql);
    const lang = langOf(req, settings);
    const t = publicStrings[lang];
    const nonce = newNonce();
    const rl = await hitRateLimit(sql, `unlock:${link.id}:${req.clientIp}`, 5, 15 * 60);
    if (rl.limited) {
      setPageHeaders(reply, ctx.config, { nonce });
      return reply.code(429).send(
        passwordPage({
          lang,
          t,
          nonce,
          settings,
          version,
          slug: link.slug,
          title: link.title,
          error: t.tooManyAttempts,
        }),
      );
    }
    if (!(await verifyPassword(link.password_hash!, password))) {
      void linkEvent(link.id, 'password_fail', req);
      setPageHeaders(reply, ctx.config, { nonce });
      return reply.code(401).send(
        passwordPage({
          lang,
          t,
          nonce,
          settings,
          version,
          slug: link.slug,
          title: link.title,
          error: t.wrongPassword,
        }),
      );
    }
    void linkEvent(link.id, 'password_ok', req);
    const exp = Math.floor(Date.now() / 1000) + UNLOCK_TTL_S;
    reply.setCookie(
      unlockCookieName(link.id),
      `${exp}.${hmacBase64Url(key, `unlock:${link.id}:${exp}:${link.password_hash!.slice(-16)}`)}`,
      {
        httpOnly: true,
        secure: ctx.config.cookieSecure,
        sameSite: 'lax',
        path: '/',
        maxAge: UNLOCK_TTL_S,
      },
    );
    return reply.redirect(`/v/${link.slug}`, 303);
  });

  /** Renews media URLs for a long viewing session; requires the page's ingest token. */
  app.get('/api/public/links/:slug/playback', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const token = verifyIngestToken(key, String(req.headers['x-vs-token'] ?? ''));
    const res = await resolveSlug(sql, slug);
    if (!token || res.kind !== 'ok' || res.link.id !== token.l) throw notFound();
    const sign = (file: string) =>
      signMediaUrl({
        key: ctx.config.MEDIA_SIGNING_KEY,
        sessionId: token.s,
        videoId: res.link.video_id,
        version: res.link.hls_version,
        file,
        ttlSec: ttl,
      });
    reply.header('cache-control', 'no-store');
    return {
      master: sign('master.m3u8'),
      spriteVtt: sign('sprite.vtt'),
      tokenExpiresAt: Math.floor(Date.now() / 1000) + ttl,
    };
  });

  const fileQuery = z.object({ s: z.string().uuid(), sig: z.string().min(10).max(64) });
  const sessionForFile = async (req: FastifyRequest, slug: string) => {
    const q = fileQuery.safeParse(req.query);
    if (!q.success || !verifySessionSig(key, q.data.s, 'file', q.data.sig)) throw forbidden();
    const res = await resolveSlug(sql, slug);
    if (res.kind !== 'ok') throw notFound();
    const s = await sql<
      { id: string }[]
    >`SELECT id FROM view_sessions WHERE id = ${q.data.s} AND link_id = ${res.link.id}`;
    return { link: res.link, sessionId: s[0]?.id ?? null };
  };

  app.get('/api/public/links/:slug/attachments/:assetId', async (req, reply) => {
    const { slug, assetId } = req.params as { slug: string; assetId: string };
    const { link, sessionId } = await sessionForFile(req, slug);
    const a = await sql<{ path: string; mime: string; filename: string | null }[]>`
      SELECT path, mime, filename FROM assets WHERE id = ${assetId} AND video_id = ${link.video_id} AND kind = 'attachment'`;
    if (!a[0]) throw notFound();
    if (sessionId) {
      await serverEvent(sql, sessionId, 'attachment_download', { asset_id: assetId, source: 'server' });
      await sql`UPDATE session_summaries SET attachment_downloads = attachment_downloads + 1, updated_at = now() WHERE session_id = ${sessionId}`;
    }
    return sendMediaFile(ctx.config, reply, a[0].path, {
      mime: a[0].mime,
      filename: a[0].filename ?? 'attachment',
      disposition: 'attachment',
      cache: 'private, no-store',
    });
  });

  app.get('/api/public/links/:slug/captions/:assetId', async (req, reply) => {
    const { slug, assetId } = req.params as { slug: string; assetId: string };
    const { link } = await sessionForFile(req, slug);
    const a = await sql<
      { path: string }[]
    >`SELECT path FROM assets WHERE id = ${assetId} AND video_id = ${link.video_id} AND kind = 'captions'`;
    if (!a[0]) throw notFound();
    return sendMediaFile(ctx.config, reply, a[0].path, {
      mime: 'text/vtt; charset=utf-8',
      cache: 'private, max-age=3600',
    });
  });

  app.get('/api/public/links/:slug/download', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const { link, sessionId } = await sessionForFile(req, slug);
    if (!link.allow_download) throw notFound();
    const a = await sql<
      { path: string }[]
    >`SELECT path FROM assets WHERE video_id = ${link.video_id} AND kind = 'download_mp4' AND hls_version = ${link.hls_version}`;
    if (!a[0]) throw notFound();
    if (sessionId) {
      await serverEvent(sql, sessionId, 'video_download', { source: 'server' });
      await sql`UPDATE session_summaries SET video_downloads = video_downloads + 1, updated_at = now() WHERE session_id = ${sessionId}`;
    }
    const safeTitle = link.title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 100) || 'video';
    return sendMediaFile(ctx.config, reply, a[0].path, {
      mime: 'video/mp4',
      filename: `${safeTitle}.mp4`,
      disposition: 'attachment',
      cache: 'private, no-store',
    });
  });

  /** CTA redirect: records the click server-side (works without JS), then 302 to the target. */
  app.get('/go/:session/:cta/:sig', async (req, reply) => {
    const { session, cta, sig } = req.params as { session: string; cta: string; sig: string };
    if (!/^[0-9a-f-]{36}$/.test(session) || !verifySessionSig(key, session, 'cta', sig)) throw notFound();
    const rows = await sql<{ cta_config: Cta[] | null; video_cta: Cta[]; stored: boolean }[]>`
      SELECT l.cta_config, v.cta_config AS video_cta, true AS stored FROM view_sessions s
      JOIN share_links l ON l.id = s.link_id JOIN videos v ON v.id = s.video_id WHERE s.id = ${session}`;
    if (!rows[0]) throw notFound();
    const target = effectiveCtas(rows[0], { cta_config: rows[0].video_cta }).find((c) => c.id === cta);
    if (!target) throw notFound();
    await serverEvent(sql, session, 'cta_click', {
      cta_id: cta,
      href_host: hostOf(target.href),
      source: 'server',
    });
    await sql`UPDATE session_summaries SET cta_clicks = cta_clicks + 1, updated_at = now() WHERE session_id = ${session}`;
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cache-control', 'no-store');
    return reply.redirect(target.href, 302);
  });

  app.get('/privacy', async (req, reply) => {
    const settings = await getSettings(sql);
    const lang = langOf(req, settings);
    const nonce = newNonce();
    setPageHeaders(reply, ctx.config, { nonce });
    reply.header('cache-control', 'public, max-age=300');
    const text = settings.privacy[lang]?.trim() || DEFAULT_PRIVACY[lang];
    return reply.send(privacyPage({ lang, t: publicStrings[lang], nonce, settings, version, text }));
  });

  // Static player bundle fallback when the api runs without nginx (development, tests).
  const playerDist =
    process.env.PLAYER_DIST ?? path.resolve(import.meta.dirname, '../../../../../packages/player/dist');
  app.get('/static/:file', async (req, reply) => {
    const { file } = req.params as { file: string };
    if (!/^[a-z0-9._-]+\.(js|css|map)$/i.test(file)) throw notFound();
    const body = await readFile(path.join(playerDist, file)).catch(() => null);
    if (!body) throw notFound();
    reply.header(
      'content-type',
      file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8',
    );
    reply.header('cache-control', 'public, max-age=300');
    return reply.send(body);
  });
}

function hostOf(href: string): string | null {
  try {
    return new URL(href).host || new URL(href).protocol.replace(':', '');
  } catch {
    return null;
  }
}
