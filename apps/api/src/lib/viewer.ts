import { UAParser } from 'ua-parser-js';
import { isbot } from 'isbot';
import { hmacBase64Url, sha256Hex } from '@vs/core';

const PREVIEW_BOTS: [RegExp, string][] = [
  [/LinkedInBot/i, 'LinkedInBot'],
  [/Slackbot|Slack-ImgProxy/i, 'Slackbot'],
  [/SkypeUriPreview|MicrosoftPreview|Teams/i, 'Microsoft Teams'],
  [/WhatsApp/i, 'WhatsApp'],
  [/TelegramBot/i, 'TelegramBot'],
  [/Discordbot/i, 'Discordbot'],
  [/Twitterbot/i, 'Twitterbot'],
  [/facebookexternalhit|Facebot|meta-externalagent/i, 'Facebook'],
  [/Applebot/i, 'Applebot'],
  [/Googlebot|Google-InspectionTool|GoogleOther/i, 'Googlebot'],
  [/bingbot|BingPreview/i, 'Bing'],
  [/Mastodon/i, 'Mastodon'],
  [/redditbot/i, 'Reddit'],
  [/Signal/i, 'Signal'],
  [/Outlook|Microsoft Office|ms-office/i, 'Microsoft Office'],
  [/Google-Safety|GoogleImageProxy/i, 'Gmail'],
];

export function detectBot(ua: string | undefined): { isBot: boolean; name: string | null } {
  const s = ua ?? '';
  if (!s.trim()) return { isBot: true, name: 'empty-ua' };
  for (const [re, name] of PREVIEW_BOTS) if (re.test(s)) return { isBot: true, name };
  if (isbot(s))
    return { isBot: true, name: (/([A-Za-z0-9_-]*bot[A-Za-z0-9_-]*)/i.exec(s)?.[1] ?? 'bot').slice(0, 64) };
  if (/HeadlessChrome|PhantomJS|Puppeteer|Playwright/i.test(s)) return { isBot: true, name: 'headless' };
  return { isBot: false, name: null };
}

export interface UaInfo {
  deviceType: string;
  os: string | null;
  browser: string | null;
  browserVersion: string | null;
}

export function parseUa(
  ua: string | undefined,
  headers: Record<string, string | string[] | undefined>,
): UaInfo {
  const r = new UAParser(ua ?? '').getResult();
  const chMobile = headers['sec-ch-ua-mobile'];
  const chPlatform =
    typeof headers['sec-ch-ua-platform'] === 'string'
      ? headers['sec-ch-ua-platform'].replace(/"/g, '')
      : null;
  const raw: string = r.device.type ?? (chMobile === '?1' ? 'mobile' : 'desktop');
  const deviceType = raw === 'smarttv' ? 'tv' : raw;
  return {
    deviceType,
    os:
      [chPlatform ?? r.os.name, chPlatform ? null : r.os.version].filter(Boolean).join(' ').slice(0, 60) ||
      null,
    browser: r.browser.name?.slice(0, 60) ?? null,
    browserVersion: r.browser.version?.split('.')[0] ?? null,
  };
}

export function referrerHost(referer: string | undefined, ownHost: string): string | null {
  if (!referer) return null;
  try {
    const h = new URL(referer).host.toLowerCase();
    return h && h !== ownHost.toLowerCase() ? h.slice(0, 255) : null;
  } catch {
    return null;
  }
}

export function utmFrom(query: Record<string, unknown>): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) {
    const v = query[k];
    if (typeof v === 'string' && v) out[k.slice(4)] = v.slice(0, 200);
  }
  return Object.keys(out).length ? out : null;
}

export function primaryLang(acceptLanguage: string | undefined): string | null {
  const first = (acceptLanguage ?? '').split(',')[0]?.split(';')[0]?.trim();
  return first ? first.slice(0, 35) : null;
}

/** Daily-salted hash of IP + UA + Accept-Language + link (unique visitor fallback, no cookies). */
export function visitorHash(
  key: string,
  ip: string | null,
  ua: string,
  acceptLanguage: string,
  linkId: string,
  day = new Date(),
): string {
  const salt = hmacBase64Url(key, `visitor-salt:${day.toISOString().slice(0, 10)}`);
  return sha256Hex(`${salt}|${ip ?? ''}|${ua}|${acceptLanguage}|${linkId}`).slice(0, 32);
}
