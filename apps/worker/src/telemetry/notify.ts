import nodemailer from 'nodemailer';
import { decryptJson, getSettings, hmacBase64Url, type Config, type Sql } from '@vs/core';
import type { Logger } from 'pino';

export interface NotifyDeps {
  sql: Sql;
  config: Config;
  log: Logger;
  fetcher?: typeof fetch;
  /** Overrides the SMTP transport (tests). */
  mailer?: { sendMail(opts: { from: string; to: string; subject: string; text: string }): Promise<unknown> };
  /** How long to wait for ip_enrich before sending (default 10 s). */
  enrichWaitMs?: number;
}

const NETWORK_FI: Record<string, string> = {
  residential_isp: 'kotiliittymä',
  mobile: 'mobiili',
  business_isp: 'yritysliittymä',
  corporate: 'yritysverkko',
  hosting_cloud: 'pilvi/palvelin',
  security_proxy: 'yrityksen tietoturvaproxy',
  vpn: 'VPN',
  tor: 'Tor',
  edu: 'oppilaitos',
  lan: 'lähiverkko',
  unknown: 'tuntematon',
};

interface SessionInfo {
  session_id: string;
  link_id: string;
  label: string;
  recipient_name: string | null;
  slug: string;
  title: string;
  notify_on_open: boolean;
  notify_every_open: boolean;
  first_notified_at: Date | null;
  notified_at: Date | null;
  summary_notified_at: Date | null;
  city: string | null;
  country: string | null;
  device_type: string | null;
  browser: string | null;
  os: string | null;
  network_type: string | null;
  org_guess: string | null;
  as_org: string | null;
  visitor_sessions: number | null;
  visitor_links: number | null;
  ip_intel_id: string | null;
  is_bot: boolean;
  completion_pct: number;
  unique_watched_ms: number;
  duration_ms: number | null;
  cta_clicks: number;
  attachment_downloads: number;
}

async function loadSession(sql: Sql, sessionId: string): Promise<SessionInfo | undefined> {
  const r = await sql<SessionInfo[]>`
    SELECT s.id AS session_id, l.id AS link_id, l.label, l.recipient_name, l.slug, v.title, l.notify_on_open, l.notify_every_open,
           l.first_notified_at, s.notified_at, s.summary_notified_at, coalesce(s.city, i.city) AS city, coalesce(s.country, i.country) AS country,
           s.device_type, s.browser, s.os, i.network_type, i.org_guess, coalesce(s.as_org, i.as_org) AS as_org, vis.session_count AS visitor_sessions,
           vis.link_count AS visitor_links, s.ip_intel_id, s.is_bot, ss.completion_pct, ss.unique_watched_ms, v.duration_ms, ss.cta_clicks,
           ss.attachment_downloads
    FROM view_sessions s JOIN share_links l ON l.id = s.link_id JOIN videos v ON v.id = s.video_id
    LEFT JOIN ip_intel i ON i.id = s.ip_intel_id LEFT JOIN visitors vis ON vis.id = s.visitor_id
    LEFT JOIN session_summaries ss ON ss.session_id = s.id
    WHERE s.id = ${sessionId}`;
  return r[0];
}

export function openMessage(s: SessionInfo, origin: string): { title: string; body: string; url: string } {
  const where = [s.city, s.country].filter(Boolean).join(', ') || 'sijainti tuntematon';
  const net = s.network_type
    ? `${s.org_guess ?? s.as_org ?? '?'} (${NETWORK_FI[s.network_type] ?? s.network_type})`
    : (s.as_org ?? 'tuntematon');
  const returning =
    s.visitor_sessions && s.visitor_sessions > 1
      ? `kyllä (${s.visitor_sessions} istuntoa, ${s.visitor_links} linkkiä)`
      : 'ei';
  return {
    title: `Linkki '${s.label}' avattiin`,
    body: `Linkki '${s.label}' avattiin – ${where}, ${s.device_type ?? 'laite ?'}, verkko: ${net}, palaava katsoja: ${returning}\nVideo: ${s.title}`,
    url: `${origin}/admin/links/${s.link_id}`,
  };
}

export function summaryMessage(s: SessionInfo, origin: string): { title: string; body: string; url: string } {
  const watched = Math.round(s.unique_watched_ms / 1000);
  return {
    title: `Katselu päättyi: '${s.label}'`,
    body: `Katsottu ${Math.round(s.completion_pct)} % (${watched} s), CTA-klikkauksia ${s.cta_clicks}, liitteitä ladattu ${s.attachment_downloads}.\nVideo: ${s.title}`,
    url: `${origin}/admin/sessions/${s.session_id}`,
  };
}

async function deliver(
  deps: NotifyDeps,
  msg: { title: string; body: string; url: string },
  sessionId: string | null,
  linkId: string | null,
  kind: string,
) {
  const { sql, config } = deps;
  const channels = await sql<
    { id: string; kind: string; config: string }[]
  >`SELECT id, kind, config FROM notification_channels WHERE is_active`;
  const fetcher = deps.fetcher ?? fetch;
  for (const ch of channels) {
    let ok = true;
    let error: string | null = null;
    try {
      const c = decryptJson<Record<string, string>>(config.APP_ENCRYPTION_KEY, ch.config);
      if (ch.kind === 'ntfy') {
        const res = await fetcher(`${c.url!.replace(/\/$/, '')}/${encodeURIComponent(c.topic!)}`, {
          method: 'POST',
          headers: {
            Title:
              encodeURIComponent(msg.title).length === msg.title.length
                ? msg.title
                : `=?UTF-8?B?${Buffer.from(msg.title).toString('base64')}?=`,
            Tags: 'eyes',
            Click: msg.url,
            ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}),
          },
          body: msg.body,
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
      } else if (ch.kind === 'email') {
        const mailer = deps.mailer ?? smtp(config);
        if (!mailer) throw new Error('SMTP not configured');
        await mailer.sendMail({
          from: config.SMTP_FROM,
          to: c.to!,
          subject: msg.title,
          text: `${msg.body}\n\n${msg.url}`,
        });
      } else if (ch.kind === 'webhook') {
        const payload = JSON.stringify({
          kind,
          title: msg.title,
          body: msg.body,
          url: msg.url,
          sessionId,
          linkId,
          ts: new Date().toISOString(),
        });
        const res = await fetcher(c.url!, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(c.secret ? { 'x-signature': hmacBase64Url(c.secret, payload) } : {}),
          },
          body: payload,
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
      }
    } catch (e) {
      ok = false;
      error = (e as Error).message.slice(0, 500);
      deps.log.warn({ channel: ch.kind, err: error }, 'notification failed');
    }
    await sql`INSERT INTO notifications_log (session_id, link_id, channel_id, kind, ok, error) VALUES (${sessionId}, ${linkId}, ${ch.id}, ${kind}, ${ok}, ${error})`;
  }
}

let transport: nodemailer.Transporter | null | undefined;
function smtp(config: Config) {
  if (transport !== undefined) return transport;
  transport = config.SMTP_HOST
    ? nodemailer.createTransport({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        secure: config.SMTP_SECURE,
        auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
      })
    : null;
  return transport;
}

/**
 * "Link opened" notification for the first human play on a link (or every open when enabled). Waits up
 * to 10 s for ip_enrich so the message can name the network. Sent at most once per session/link.
 */
export async function notifyOpen(deps: NotifyDeps, sessionId: string): Promise<boolean> {
  const { sql } = deps;
  let s = await loadSession(sql, sessionId);
  if (!s || s.is_bot || !s.notify_on_open || s.notified_at) return false;
  const deadline = Date.now() + (deps.enrichWaitMs ?? 10_000);
  while (!s.ip_intel_id && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    s = (await loadSession(sql, sessionId))!;
  }
  // Claim atomically: first open of the link, or every open if configured.
  const claimed = await sql`
    UPDATE share_links SET first_notified_at = coalesce(first_notified_at, now())
    WHERE id = ${s.link_id} AND (first_notified_at IS NULL OR notify_every_open) RETURNING id`;
  if (!claimed.length) return false;
  const marked =
    await sql`UPDATE view_sessions SET notified_at = now() WHERE id = ${sessionId} AND notified_at IS NULL RETURNING id`;
  if (!marked.length) return false;
  await deliver(deps, openMessage(s, deps.config.publicOrigin), sessionId, s.link_id, 'open');
  return true;
}

/** Optional end-of-session summary (setting notifications.sessionSummary) for sessions that triggered an open notification. */
export async function notifySummary(deps: NotifyDeps, sessionId: string): Promise<boolean> {
  const settings = await getSettings(deps.sql);
  if (!settings.notifications.sessionSummary) return false;
  const s = await loadSession(deps.sql, sessionId);
  if (!s || !s.notified_at || s.summary_notified_at) return false;
  const marked =
    await deps.sql`UPDATE view_sessions SET summary_notified_at = now() WHERE id = ${sessionId} AND summary_notified_at IS NULL RETURNING id`;
  if (!marked.length) return false;
  await deliver(deps, summaryMessage(s, deps.config.publicOrigin), sessionId, s.link_id, 'summary');
  return true;
}

/** A viewer left a written comment (story-mode feedback). Sent once per session. */
export async function notifyFeedback(deps: NotifyDeps, sessionId: string): Promise<boolean> {
  const { sql } = deps;
  const f = await sql<
    { rating: string; comment: string | null; label: string; title: string; link_id: string }[]
  >`
    UPDATE feedback f SET notified_at = now() FROM share_links l, videos v
    WHERE f.session_id = ${sessionId} AND f.notified_at IS NULL AND f.comment IS NOT NULL AND l.id = f.link_id AND v.id = f.video_id
    RETURNING f.rating, f.comment, l.label, v.title, f.link_id`;
  const r = f[0];
  if (!r) return false;
  const emoji = r.rating === 'up' ? '👍' : r.rating === 'down' ? '👎' : '🤷';
  await deliver(
    deps,
    {
      title: `Palaute linkiltä '${r.label}' ${emoji}`,
      body: `${r.comment!.slice(0, 1000)}\nVideo: ${r.title}`,
      url: `${deps.config.publicOrigin}/admin/sessions/${sessionId}`,
    },
    sessionId,
    r.link_id,
    'feedback',
  );
  return true;
}

/** Admin security events: sign-in from a new address, account lockout. */
export async function notifyAdmin(
  deps: NotifyDeps,
  d: { kind: 'admin_login' | 'admin_lockout'; userId: string; ip: string | null; userAgent?: string },
): Promise<boolean> {
  const u = await deps.sql<{ email: string }[]>`SELECT email FROM admin_users WHERE id = ${d.userId}`;
  if (!u[0]) return false;
  const title =
    d.kind === 'admin_login'
      ? `Uusi kirjautuminen hallintaan: ${u[0].email}`
      : `Hallintatili lukittu: ${u[0].email}`;
  const body = [
    d.kind === 'admin_login'
      ? 'Kirjautuminen osoitteesta, jota ei ole käytetty 90 päivään.'
      : 'Liian monta väärää salasanaa, tili lukittu 15 minuutiksi.',
    `IP: ${d.ip ?? '?'}`,
    d.userAgent ? `Selain: ${d.userAgent}` : '',
    'Jos tämä et ollut sinä: kirjaudu sisään, kirjaa muut istunnot ulos ja vaihda salasana.',
  ]
    .filter(Boolean)
    .join('\n');
  await deliver(deps, { title, body, url: `${deps.config.publicOrigin}/admin/audit` }, null, null, d.kind);
  return true;
}

/** Sends a test message to one channel (admin "Test" button). */
export async function notifyTest(deps: NotifyDeps, channelId: string): Promise<void> {
  const ch = await deps.sql`SELECT id FROM notification_channels WHERE id = ${channelId}`;
  if (!ch.length) throw new Error('channel not found');
  await deliver(
    { ...deps },
    {
      title: 'video-share: testi-ilmoitus',
      body: 'Ilmoituskanava toimii.',
      url: `${deps.config.publicOrigin}/admin/`,
    },
    null as unknown as string,
    null as unknown as string,
    'test',
  );
}
