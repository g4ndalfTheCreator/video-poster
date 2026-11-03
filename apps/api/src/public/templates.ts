import type { Settings } from '@vs/shared';
import type { Lang, PublicStrings } from '../i18n/public.js';
import { esc, jsonForHtml, simpleMarkdown } from './html.js';

interface Shell {
  lang: Lang;
  title: string;
  nonce: string;
  settings: Settings;
  t: PublicStrings;
  head?: string;
  body: string;
  version: string;
  bodyClass?: string;
  /** Inline brand colour (needs the CSP nonce); off for the generic 404 so its body is byte-identical. */
  brand?: boolean;
}

function brandStyle(nonce: string, settings: Settings): string {
  const color = /^#[0-9a-fA-F]{6}$/.test(settings.branding.primaryColor)
    ? settings.branding.primaryColor
    : '#2563eb';
  return `<style nonce="${esc(nonce)}">:root{--vs-brand:${color}}</style>`;
}

export function page(s: Shell): string {
  return `<!doctype html>
<html lang="${s.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>${esc(s.title)}</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/static/player.css?v=${esc(s.version)}">
${s.brand === false ? '' : brandStyle(s.nonce, s.settings)}
${s.head ?? ''}
</head>
<body class="${esc(s.bodyClass ?? '')}">
${s.body}
<footer class="vs-footer"><span>${esc(s.settings.branding.footer)}</span> <a href="/privacy?lang=${s.lang}">${esc(s.t.privacy)}</a></footer>
</body>
</html>`;
}

export function notFoundPage(o: {
  lang: Lang;
  t: PublicStrings;
  nonce: string;
  settings: Settings;
  version: string;
}): string {
  return page({
    ...o,
    title: o.t.notFoundTitle,
    brand: false,
    body: `<main class="vs-center"><h1>${esc(o.t.notFoundTitle)}</h1><p>${esc(o.t.notFoundBody)}</p></main>`,
  });
}

export function passwordPage(o: {
  lang: Lang;
  t: PublicStrings;
  nonce: string;
  settings: Settings;
  version: string;
  slug: string;
  error?: string;
  title: string;
}): string {
  return page({
    ...o,
    title: o.t.passwordTitle,
    body: `<main class="vs-center">
<h1>${esc(o.t.passwordTitle)}</h1>
<p>${esc(o.t.passwordPrompt)}</p>
<form method="post" action="/v/${esc(o.slug)}/unlock" class="vs-form">
<label for="pw">${esc(o.t.password)}</label>
<input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
${o.error ? `<p class="vs-error" role="alert">${esc(o.error)}</p>` : ''}
<button type="submit">${esc(o.t.open)}</button>
</form>
</main>`,
  });
}

export function privacyPage(o: {
  lang: Lang;
  t: PublicStrings;
  nonce: string;
  settings: Settings;
  version: string;
  text: string;
}): string {
  return page({
    ...o,
    title: o.t.privacyTitle,
    body: `<main class="vs-prose"><h1>${esc(o.t.privacyTitle)}</h1>${simpleMarkdown(o.text)}</main>`,
  });
}

export interface WatchView {
  lang: Lang;
  t: PublicStrings;
  nonce: string;
  settings: Settings;
  version: string;
  title: string;
  description: string;
  url: string;
  ogImage: string | null;
  posterUrl: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  masterUrl: string | null;
  attachments: { label: string; href: string; size: number }[];
  ctas: { id: string; label: string; href: string }[];
  downloadHref: string | null;
  captions: { lang: string; label: string; src: string }[];
  /** Player/telemetry config; null for link-preview bots (no session). */
  config: Record<string, unknown> | null;
  embed?: boolean;
}

export function watchPage(v: WatchView): string {
  const og = [
    ['og:type', 'video.other'],
    ['og:title', v.title],
    ['og:description', v.description],
    ['og:url', v.url],
    ['og:site_name', v.settings.branding.name],
    ...(v.ogImage
      ? [
          ['og:image', v.ogImage],
          ['og:image:width', '1280'],
        ]
      : []),
    ['twitter:card', v.ogImage ? 'summary_large_image' : 'summary'],
    ['twitter:title', v.title],
    ['twitter:description', v.description],
    ...(v.ogImage ? [['twitter:image', v.ogImage]] : []),
  ]
    .map(([k, val]) => `<meta property="${esc(k)}" content="${esc(val)}">`)
    .join('\n');
  const aspect = v.width && v.height ? `${v.width} / ${v.height}` : '16 / 9';
  const portrait = !!(v.width && v.height && v.height > v.width);
  const fmtSize = (n: number) =>
    n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`;
  const body = `<main class="vs-watch${v.embed ? ' vs-embed' : ''}">
<div class="vs-player${portrait ? ' vs-portrait' : ''}" data-aspect="${esc(aspect)}">
<video id="vs-video" class="vs-video" playsinline preload="none" ${v.posterUrl ? `poster="${esc(v.posterUrl)}"` : ''} ${v.masterUrl ? `src="${esc(v.masterUrl)}"` : ''} controls>
${v.captions.map((c) => `<track kind="subtitles" srclang="${esc(c.lang)}" label="${esc(c.label)}" src="${esc(c.src)}">`).join('\n')}
</video>
<noscript><p class="vs-noscript">${esc(v.t.noscript)}</p></noscript>
</div>
${
  v.embed
    ? ''
    : `<section class="vs-meta">
<h1>${esc(v.title)}</h1>
${
  v.description
    ? `<div class="vs-desc">${v.description
        .split(/\n{2,}/)
        .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
        .join('')}</div>`
    : ''
}
${
  v.ctas.length
    ? `<div class="vs-ctas">${v.ctas.map((c) => `<a class="vs-cta" data-cta="${esc(c.id)}" href="${esc(c.href)}" rel="noopener noreferrer">${esc(c.label)}</a>`).join('')}</div>`
    : ''
}
${
  v.attachments.length || v.downloadHref
    ? `<div class="vs-attachments"><h2>${esc(v.t.attachments)}</h2><ul>
${v.attachments.map((a) => `<li><a href="${esc(a.href)}" data-attachment="1">${esc(a.label)}</a> <span>(${esc(fmtSize(a.size))})</span></li>`).join('\n')}
${v.downloadHref ? `<li><a href="${esc(v.downloadHref)}" data-download="1">${esc(v.t.download)}</a></li>` : ''}
</ul></div>`
    : ''
}
</section>`
}
</main>
${v.config ? `<script type="application/json" id="vs-config">${jsonForHtml(v.config)}</script>\n<script src="/static/player.js?v=${esc(v.version)}" defer></script>` : ''}`;
  return page({
    lang: v.lang,
    t: v.t,
    nonce: v.nonce,
    settings: v.settings,
    version: v.version,
    title: v.title,
    head: `<meta name="description" content="${esc(v.description.slice(0, 300))}">\n${og}`,
    body,
    bodyClass: v.embed ? 'vs-embed-body' : '',
  });
}
