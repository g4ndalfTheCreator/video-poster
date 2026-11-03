import { unionRanges, rangesLength, type Range } from '@vs/shared/ranges';
import type { PageConfig } from '../config.js';
import type { Player } from '../player.js';
import { collectFingerprint } from './fingerprint.js';

interface Ev {
  seq: number;
  type: string;
  client_ts: number;
  position_ms: number;
  payload: Record<string, unknown>;
  n?: number;
}

/**
 * Client telemetry SDK: batches events to /t/v1/events (fetch keepalive, every 10 s or 20 events) and
 * flushes with sendBeacon when the page is hidden or closed. The server validates everything.
 */
export function startTelemetry(cfg: PageConfig, player: Player): void {
  const v = player.video;
  const q: Ev[] = [];
  let seq = 0;
  const pos = () => Math.round(v.currentTime * 1000);
  const push = (type: string, payload: Record<string, unknown> = {}) => {
    q.push({ seq: seq++, type, client_ts: Date.now(), position_ms: pos(), payload });
    if (q.length >= 20) flush();
  };
  const body = (events: Ev[]) =>
    JSON.stringify({ token: cfg.token, events: events.map(({ n: _n, ...e }) => e) });
  const flush = (beacon = false) => {
    while (q.length) {
      const batch = q.splice(0, 50);
      if (beacon && navigator.sendBeacon?.(cfg.beaconUrl, new Blob([body(batch)], { type: 'text/plain' })))
        continue;
      fetch(cfg.ingestUrl, {
        method: 'POST',
        keepalive: true,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: body(batch),
      })
        .then((r) => {
          if (r.status >= 500 || r.status === 429) throw new Error(String(r.status));
        })
        .catch(() => {
          // Exponential retry, at most 3 times per event.
          const again = batch.filter((e) => (e.n = (e.n ?? 0) + 1) <= 3);
          if (again.length) setTimeout(() => (q.unshift(...again), flush()), 1000 * 2 ** (again[0]!.n! - 1));
        });
      if (beacon) continue;
      break;
    }
  };
  setInterval(() => flush(), 10_000);

  // ---- page view + browser profile
  const sp = new URLSearchParams(location.search);
  const utm: Record<string, string> = {};
  sp.forEach((val, k) => k.startsWith('utm_') && (utm[k.slice(4)] = val));
  const conn = (navigator as Navigator & { connection?: { effectiveType?: string } }).connection;
  push('page_view', {
    viewport: { w: innerWidth, h: innerHeight },
    screen: { w: screen.width, h: screen.height },
    dpr: devicePixelRatio,
    lang: navigator.language,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    effectiveType: conn?.effectiveType,
    referrer: document.referrer,
    utm,
    webdriver: navigator.webdriver === true,
  });
  setTimeout(() => {
    const t0 = performance.now();
    void collectFingerprint().then((f) =>
      push('fingerprint', { ...f, elapsed_ms: Math.round(performance.now() - t0) }),
    );
  }, 0);

  // ---- played ranges (raw, may overlap: rewatches) and quartiles
  let cur: Range | null = null;
  let pending: Range[] = [];
  let all: Range[] = [];
  const quartiles = new Set<number>();
  const close = () => {
    if (cur && cur[1] > cur[0]) pending.push(cur);
    cur = null;
  };
  const track = () => {
    if (v.paused || v.seeking) return;
    const t = pos();
    if (cur && t >= cur[1] - 250 && t - cur[1] < 2000 * Math.max(1, v.playbackRate)) cur = [cur[0], t];
    else {
      close();
      cur = [t, t];
    }
  };
  const heartbeat = () => {
    track();
    const deltas = [...pending, ...(cur && cur[1] > cur[0] ? [cur] : [])];
    pending = [];
    if (cur) cur = [cur[1], cur[1]];
    if (!deltas.length) return;
    all = unionRanges([...all, ...deltas]);
    const d = v.duration * 1000;
    if (d > 0) {
      const pct = (rangesLength(all) / d) * 100;
      for (const qv of [25, 50, 75, 100]) {
        if (!quartiles.has(qv) && pct >= (qv === 100 ? 95 : qv)) {
          quartiles.add(qv);
          push('quartile', { q: qv });
        }
      }
    }
    const lvl = player.hls?.levels[player.hls.currentLevel];
    const b = v.buffered;
    push('heartbeat', {
      played_delta: deltas.map((r) => [Math.round(r[0]), Math.round(r[1])]),
      rendition: lvl ? Math.min(lvl.width, lvl.height) : undefined,
      bandwidth_kbps: player.hls ? Math.round(player.hls.bandwidthEstimate / 1000) : undefined,
      buffer_ms: b.length ? Math.max(0, Math.round((b.end(b.length - 1) - v.currentTime) * 1000)) : 0,
      volume: Math.round(v.volume * 100) / 100,
      muted: v.muted,
      rate: v.playbackRate,
    });
  };
  v.addEventListener('timeupdate', track);
  setInterval(() => !v.paused && heartbeat(), 5000);

  // ---- player events
  const t0 = performance.now();
  let playAt = 0;
  let firstFrame = false;
  let intent: 'user' | 'system' = 'system';
  let stallAt = 0;
  let seekFrom = 0;
  let replays = 0;
  let ended = false;
  player.on((e) => {
    if (e.type === 'intent') intent = 'user';
    else if (e.type === 'manifest')
      push('player_ready', { startup_ms: Math.round(performance.now() - t0), renditions: e.levels });
    else if (e.type === 'quality')
      push('quality_change', { from: e.from, to: e.to ?? undefined, auto: e.auto });
    else if (e.type === 'level' && e.auto) push('quality_change', { to: e.height, auto: true });
    else if (e.type === 'captions') push('captions_toggle', { lang: e.lang });
    else if (e.type === 'fullscreen' || e.type === 'pip') push(e.type, { enabled: e.enabled });
    else if (e.type === 'error')
      push('error', {
        code: String(e.code),
        fatal: !!e.fatal,
        message: String(e.message ?? '').slice(0, 200),
      });
  });
  if (!player.hls)
    v.addEventListener(
      'loadedmetadata',
      () => push('player_ready', { startup_ms: Math.round(performance.now() - t0) }),
      { once: true },
    );
  v.addEventListener('play', () => {
    if (ended) replays++;
    ended = false;
    playAt = performance.now();
    push('play', { source: v.autoplay && intent === 'system' ? 'autoplay' : intent });
    intent = 'system';
  });
  v.addEventListener('pause', () => {
    if (v.ended) return;
    heartbeat();
    push('pause', { source: intent });
    intent = 'system';
  });
  v.addEventListener('playing', () => {
    if (!firstFrame) {
      firstFrame = true;
      push('first_frame', { ttff_ms: Math.round(performance.now() - playAt) });
    }
    if (stallAt) {
      push('rebuffer_end', { duration_ms: Math.round(performance.now() - stallAt) });
      stallAt = 0;
    }
  });
  v.addEventListener('waiting', () => {
    if (firstFrame && !v.seeking && !stallAt) {
      stallAt = performance.now();
      push('rebuffer_start');
    }
  });
  v.addEventListener('seeking', () => {
    track();
    close();
    seekFrom = cur ? cur[1] : pending.length ? pending[pending.length - 1]![1] : seekFrom;
  });
  v.addEventListener('seeked', () => push('seek', { from_ms: Math.round(seekFrom), to_ms: pos() }));
  v.addEventListener('ended', () => {
    heartbeat();
    ended = true;
    push('ended', { replay_count: replays });
  });
  let volTimer = 0;
  v.addEventListener('volumechange', () => {
    clearTimeout(volTimer);
    volTimer = window.setTimeout(
      () => push('volume_change', { volume: Math.round(v.volume * 100) / 100, muted: v.muted }),
      1000,
    );
  });
  v.addEventListener('timeupdate', () => (seekFrom = pos()));

  // ---- links on the page
  let navigating = false;
  document.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    if (a.dataset.cta) {
      navigating = true;
      push('cta_click', {
        cta_id: a.dataset.cta,
        href_host: cfg.ctas.find((c) => c.id === a.dataset.cta)?.host ?? undefined,
      });
    } else if (a.dataset.attachment)
      push('attachment_download', { asset_id: /attachments\/([^/?]+)/.exec(a.href)?.[1] ?? '' });
    else if (a.dataset.download) push('video_download');
    flush();
  });

  document.addEventListener('visibilitychange', () => {
    push('visibility', { state: document.visibilityState === 'hidden' ? 'hidden' : 'visible' });
    if (document.visibilityState === 'hidden') {
      heartbeat();
      flush(true);
    }
  });
  addEventListener('pagehide', () => {
    heartbeat();
    push('session_end', { exit_reason: navigating ? 'navigated' : 'closed' });
    flush(true);
  });
}
