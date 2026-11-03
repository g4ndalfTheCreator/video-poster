import Hls from 'hls.js/light';
import { PLAYER_MAX_BUFFER_SECONDS } from '@vs/shared/constants';
import type { PageConfig } from './config.js';

type Listener = (e: { type: string; [k: string]: unknown }) => void;

/**
 * Player core: attaches HLS (hls.js light where MSE exists, native HLS on Safari/iOS), renews signed
 * media tokens and emits events. The visible controls are layered on top by `controls.ts` (classic
 * page) or `story.ts` (story page), so each page only ships the UI it uses.
 */
export class Player {
  readonly video: HTMLVideoElement;
  readonly root: HTMLElement;
  readonly cfg: PageConfig;
  hls: Hls | null = null;
  private listeners: Listener[] = [];
  private mediaBase: string;
  private errorEl: HTMLElement;

  constructor(video: HTMLVideoElement, cfg: PageConfig) {
    this.video = video;
    this.cfg = cfg;
    const r = (this.root = video.parentElement as HTMLElement);
    this.mediaBase = cfg.master.slice(0, cfg.master.lastIndexOf('/') + 1);
    r.classList.add('vs-js');
    this.errorEl = document.createElement('div');
    this.errorEl.className = 'vs-err';
    this.errorEl.setAttribute('role', 'alert');
    this.errorEl.hidden = true;
    this.errorEl.textContent = cfg.strings.error;
    r.append(this.errorEl);
    const sync = () => r.classList.toggle('vs-playing', !video.paused && !video.ended);
    for (const ev of ['play', 'pause', 'ended']) video.addEventListener(ev, sync);
    document.addEventListener('fullscreenchange', () =>
      this.emit('fullscreen', { enabled: document.fullscreenElement === r }),
    );
    video.addEventListener('enterpictureinpicture', () => this.emit('pip', { enabled: true }));
    video.addEventListener('leavepictureinpicture', () => this.emit('pip', { enabled: false }));
    this.attachSource();
    this.scheduleTokenRefresh();
  }

  on(fn: Listener) {
    this.listeners.push(fn);
  }
  emit(type: string, data: Record<string, unknown> = {}) {
    for (const l of this.listeners) l({ type, ...data });
  }

  private attachSource() {
    const v = this.video;
    v.controls = false;
    v.preload = 'metadata';
    if (this.cfg.autoplayMuted) {
      v.muted = true;
      v.autoplay = true;
    }
    if (Hls.isSupported()) {
      v.removeAttribute('src');
      const hls = new Hls({
        maxBufferLength: PLAYER_MAX_BUFFER_SECONDS,
        maxMaxBufferLength: PLAYER_MAX_BUFFER_SECONDS * 2,
        backBufferLength: 30,
        capLevelToPlayerSize: true,
        // Media URLs carry the signed token in the path; after a refresh, rewrite older prefixes.
        xhrSetup: (xhr, url) => {
          const fixed = url.replace(/^(.*\/media\/)[^/]+\/\d+\/[^/]+\/[^/]+\/\d+\//, () =>
            new URL(this.mediaBase, location.href).toString(),
          );
          xhr.open('GET', fixed, true);
        },
      });
      this.hls = hls;
      hls.loadSource(this.cfg.master);
      hls.attachMedia(v);
      hls.on(Hls.Events.MANIFEST_PARSED, (_e, d) =>
        this.emit('manifest', { levels: d.levels.map((l) => l.height) }),
      );
      hls.on(Hls.Events.LEVEL_SWITCHED, (_e, d) =>
        this.emit('level', {
          level: d.level,
          height: hls.levels[d.level]?.height,
          auto: hls.autoLevelEnabled,
        }),
      );
      hls.on(Hls.Events.ERROR, (_e, d) => {
        this.emit('error', { code: d.details, fatal: d.fatal, message: d.reason ?? d.details });
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) void this.refreshToken().then(() => hls.startLoad());
        else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else this.showError();
      });
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = this.cfg.master;
      v.addEventListener('error', () => {
        this.emit('error', {
          code: `media_${v.error?.code ?? 0}`,
          fatal: true,
          message: v.error?.message ?? '',
        });
        this.showError();
      });
    } else this.showError();
  }

  toggle() {
    const v = this.video;
    if (v.paused || v.ended) {
      this.emit('intent', { action: 'play' });
      void v.play().catch(() => undefined);
    } else {
      this.emit('intent', { action: 'pause' });
      v.pause();
    }
  }

  seekTo(t: number) {
    const v = this.video;
    if (Number.isFinite(t)) v.currentTime = Math.min(Math.max(0, t), v.duration || t);
  }

  toggleCaptions() {
    const tracks = Array.from(this.video.textTracks);
    const on = tracks.find((t) => t.mode === 'showing');
    tracks.forEach((t) => (t.mode = 'disabled'));
    let lang: string | null = null;
    if (!on && tracks[0]) {
      const pref =
        tracks.find(
          (t) => document.documentElement.lang && t.language.startsWith(document.documentElement.lang),
        ) ?? tracks[0];
      pref.mode = 'showing';
      lang = pref.language;
    }
    this.emit('captions', { lang });
  }

  async toggleFullscreen() {
    const r = this.root;
    const vid = this.video as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (r.requestFullscreen) await r.requestFullscreen().catch(() => undefined);
    else vid.webkitEnterFullscreen?.();
  }

  async togglePip() {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await this.video.requestPictureInPicture().catch(() => undefined);
  }

  private scheduleTokenRefresh() {
    const ms = (this.cfg.tokenExpiresAt - 600) * 1000 - Date.now();
    window.setTimeout(
      () => void this.refreshToken().then(() => this.scheduleTokenRefresh()),
      Math.max(60_000, ms),
    );
  }

  async refreshToken(): Promise<void> {
    try {
      const res = await fetch(this.cfg.playbackUrl, {
        headers: { 'x-vs-token': this.cfg.token },
        credentials: 'same-origin',
      });
      if (!res.ok) return;
      const d = (await res.json()) as { master: string; tokenExpiresAt: number };
      this.cfg.master = d.master;
      this.cfg.tokenExpiresAt = d.tokenExpiresAt;
      this.mediaBase = d.master.slice(0, d.master.lastIndexOf('/') + 1);
    } catch {
      /* retried on next error */
    }
  }

  showError() {
    this.errorEl.hidden = false;
  }
}
