import Hls from 'hls.js/light';
import { PLAYER_MAX_BUFFER_SECONDS } from '@vs/shared/constants';
import type { PageConfig } from './config.js';
import { cueAt, parseSpriteVtt, type SpriteCue } from './sprite.js';

type Listener = (e: { type: string; [k: string]: unknown }) => void;

const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  attrs: Record<string, string> = {},
): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  el.className = cls;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

const fmt = (s: number) => {
  if (!Number.isFinite(s)) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

const ICON: Record<string, string> = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 5h4v14H6zm8 0h4v14h-4z',
  vol: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z',
  mute: 'M3 9v6h4l5 5V4L7 9H3zm13.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4z',
  cc: 'M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1z',
  hd: 'M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.3 7.3 0 0 0-1.7-1L15 3h-4l-.4 2.7a7.3 7.3 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.3 7.3 0 0 0 1.7 1L11 21h4l.4-2.7a7.3 7.3 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z',
  pip: 'M19 11h-8v6h8v-6zm4 8V5a2 2 0 0 0-2-2H3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2zm-2 0H3V5h18v14z',
  fs: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
};
const icon = (name: string) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${ICON[name]}"/></svg>`;

/**
 * Lightweight HLS player with an accessible custom control bar. hls.js (light build) is used where
 * Media Source Extensions are available; Safari/iOS play HLS natively.
 */
export class Player {
  readonly video: HTMLVideoElement;
  hls: Hls | null = null;
  private root: HTMLElement;
  private cfg: PageConfig;
  private listeners: Listener[] = [];
  private mediaBase: string;
  private cues: SpriteCue[] = [];
  private btn: Record<string, HTMLButtonElement> = {};
  private seek!: HTMLElement;
  private seekFill!: HTMLElement;
  private seekBuf!: HTMLElement;
  private timeEl!: HTMLElement;
  private thumb!: HTMLElement;
  private menu!: HTMLElement;
  private errorEl!: HTMLElement;
  private hideTimer = 0;

  constructor(video: HTMLVideoElement, cfg: PageConfig) {
    this.video = video;
    this.cfg = cfg;
    this.root = video.parentElement as HTMLElement;
    this.mediaBase = cfg.master.slice(0, cfg.master.lastIndexOf('/') + 1);
    this.buildUi();
    this.attachSource();
    this.bindKeys();
    this.scheduleTokenRefresh();
    void this.loadSprite();
  }

  on(fn: Listener) {
    this.listeners.push(fn);
  }
  private emit(type: string, data: Record<string, unknown> = {}) {
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
      hls.on(Hls.Events.MANIFEST_PARSED, (_e, d) => {
        this.emit('manifest', { levels: d.levels.map((l) => l.height) });
        this.buildQualityMenu();
      });
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
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) {
          void this.refreshToken().then(() => hls.startLoad());
        } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
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

  private buildUi() {
    const s = this.cfg.strings;
    const r = this.root;
    r.classList.add('vs-js');
    r.tabIndex = 0;
    r.setAttribute('role', 'region');
    r.setAttribute('aria-label', document.title);
    const big = h('button', 'vs-big', { type: 'button', 'aria-label': s.play });
    big.innerHTML = icon('play');
    big.onclick = () => this.toggle();
    const bar = h('div', 'vs-bar');
    const mk = (name: string, label: string, onClick: () => void, ic = name) => {
      const b = h('button', `vs-btn vs-${name}`, { type: 'button', 'aria-label': label, title: label });
      b.innerHTML = icon(ic);
      b.onclick = onClick;
      this.btn[name] = b;
      return b;
    };
    this.seek = h('div', 'vs-seek', {
      role: 'slider',
      tabindex: '0',
      'aria-label': s.seek,
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': '0',
    });
    this.seekBuf = h('div', 'vs-seek-buf');
    this.seekFill = h('div', 'vs-seek-fill');
    this.thumb = h('div', 'vs-thumb', { 'aria-hidden': 'true' });
    this.seek.append(this.seekBuf, this.seekFill, this.thumb);
    this.timeEl = h('span', 'vs-time', { 'aria-live': 'off' });
    const vol = h('input', 'vs-vol', {
      type: 'range',
      min: '0',
      max: '1',
      step: '0.05',
      'aria-label': s.volume,
    }) as HTMLInputElement;
    vol.value = String(this.video.volume);
    vol.oninput = () => {
      this.video.volume = Number(vol.value);
      this.video.muted = this.video.volume === 0;
    };
    this.menu = h('div', 'vs-menu', { role: 'menu', hidden: '' });
    this.errorEl = h('div', 'vs-err', { role: 'alert', hidden: '' });
    this.errorEl.textContent = s.error;
    const left = h('div', 'vs-left');
    left.append(
      mk('play', s.play, () => this.toggle()),
      mk('mute', s.mute, () => (this.video.muted = !this.video.muted), 'vol'),
      vol,
      this.timeEl,
    );
    const right = h('div', 'vs-right');
    if (this.video.textTracks.length) right.append(mk('cc', s.captions, () => this.toggleCaptions()));
    right.append(mk('hd', s.quality, () => this.toggleMenu()));
    this.btn.hd!.hidden = true;
    if (document.pictureInPictureEnabled) right.append(mk('pip', s.pip, () => void this.togglePip()));
    right.append(mk('fs', s.fullscreen, () => void this.toggleFullscreen()));
    const row = h('div', 'vs-row');
    row.append(left, right);
    bar.append(this.seek, row);
    r.append(big, bar, this.menu, this.errorEl);

    const v = this.video;
    v.addEventListener('click', () => this.toggle());
    v.addEventListener('dblclick', () => void this.toggleFullscreen());
    const sync = () => {
      const playing = !v.paused && !v.ended;
      r.classList.toggle('vs-playing', playing);
      this.btn.play!.innerHTML = icon(playing ? 'pause' : 'play');
      this.btn.play!.setAttribute('aria-label', playing ? s.pause : s.play);
      big.hidden = playing;
    };
    v.addEventListener('play', sync);
    v.addEventListener('pause', sync);
    v.addEventListener('ended', sync);
    v.addEventListener('timeupdate', () => this.updateTime());
    v.addEventListener('durationchange', () => this.updateTime());
    v.addEventListener('progress', () => this.updateTime());
    v.addEventListener('volumechange', () => {
      const m = v.muted || v.volume === 0;
      this.btn.mute!.innerHTML = icon(m ? 'mute' : 'vol');
      this.btn.mute!.setAttribute('aria-label', m ? s.unmute : s.mute);
      vol.value = String(v.muted ? 0 : v.volume);
    });
    document.addEventListener('fullscreenchange', () => {
      const fs = document.fullscreenElement === r;
      this.btn.fs!.setAttribute('aria-label', fs ? s.exitFullscreen : s.fullscreen);
      this.emit('fullscreen', { enabled: fs });
    });
    v.addEventListener('enterpictureinpicture', () => this.emit('pip', { enabled: true }));
    v.addEventListener('leavepictureinpicture', () => this.emit('pip', { enabled: false }));
    r.addEventListener('pointermove', () => this.wake());

    // seek bar: pointer drag, hover thumbnails, keyboard
    const posFromEvent = (e: PointerEvent) => {
      const rect = this.seek.getBoundingClientRect();
      return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    };
    let dragging = false;
    this.seek.addEventListener('pointerdown', (e) => {
      dragging = true;
      this.seek.setPointerCapture(e.pointerId);
      this.seekTo(posFromEvent(e) * (v.duration || 0));
    });
    this.seek.addEventListener('pointermove', (e) => {
      const p = posFromEvent(e);
      if (dragging) this.seekTo(p * (v.duration || 0));
      this.showThumb(p);
    });
    this.seek.addEventListener('pointerup', () => (dragging = false));
    this.seek.addEventListener('pointerleave', () => (this.thumb.style.display = 'none'));
    this.seek.addEventListener('keydown', (e) => {
      if (e.key === 'Home') this.seekTo(0);
      else if (e.key === 'End') this.seekTo(v.duration);
      else return;
      e.preventDefault();
    });
    sync();
    this.updateTime();
  }

  private wake() {
    this.root.classList.add('vs-active');
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.root.classList.remove('vs-active'), 2500);
  }

  private updateTime() {
    const v = this.video;
    const d = v.duration || (this.cfg.durationMs ?? 0) / 1000;
    const pct = d ? (v.currentTime / d) * 100 : 0;
    this.seekFill.style.width = `${pct}%`;
    const b = v.buffered;
    this.seekBuf.style.width = d && b.length ? `${(b.end(b.length - 1) / d) * 100}%` : '0';
    this.seek.setAttribute('aria-valuenow', String(Math.round(pct)));
    this.seek.setAttribute('aria-valuetext', `${fmt(v.currentTime)} / ${fmt(d)}`);
    this.timeEl.textContent = `${fmt(v.currentTime)} / ${fmt(d)}`;
  }

  private showThumb(p: number) {
    const c = cueAt(this.cues, p * (this.video.duration || (this.cfg.durationMs ?? 0) / 1000));
    const st = this.thumb.style;
    if (!c) {
      st.display = 'none';
      return;
    }
    st.display = 'block';
    st.width = `${c.w}px`;
    st.height = `${c.h}px`;
    st.backgroundImage = `url("${c.url}")`;
    st.backgroundPosition = `-${c.x}px -${c.y}px`;
    const w = this.seek.clientWidth;
    st.left = `${Math.min(Math.max(0, p * w - c.w / 2), Math.max(0, w - c.w))}px`;
  }

  private async loadSprite() {
    try {
      const res = await fetch(this.cfg.spriteVtt, { credentials: 'same-origin' });
      if (res.ok)
        this.cues = parseSpriteVtt(await res.text(), new URL(this.cfg.spriteVtt, location.href).toString());
    } catch {
      /* thumbnails are optional */
    }
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
    if (!Number.isFinite(t)) return;
    v.currentTime = Math.min(Math.max(0, t), v.duration || t);
    this.updateTime();
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
    this.btn.cc?.classList.toggle('vs-on', !!lang);
    this.btn.cc?.setAttribute('aria-pressed', String(!!lang));
    this.emit('captions', { lang });
  }

  private buildQualityMenu() {
    const hls = this.hls;
    if (!hls || hls.levels.length < 2) return;
    this.btn.hd!.hidden = false;
    this.menu.innerHTML = '';
    const items: [number, string][] = [
      [-1, this.cfg.strings.auto],
      ...hls.levels.map((l, i) => [i, `${Math.min(l.width, l.height)}p`] as [number, string]).reverse(),
    ];
    for (const [i, label] of items) {
      const b = h('button', 'vs-mi', {
        type: 'button',
        role: 'menuitemradio',
        'aria-checked': String(i === -1),
      });
      b.textContent = label;
      b.onclick = () => {
        const from = hls.currentLevel;
        hls.currentLevel = i;
        this.menu.querySelectorAll('.vs-mi').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
        this.emit('quality', {
          from: hls.levels[from]?.height,
          to: i < 0 ? null : hls.levels[i]?.height,
          auto: i < 0,
        });
        this.toggleMenu(false);
      };
      this.menu.append(b);
    }
  }

  private toggleMenu(force?: boolean) {
    const show = force ?? this.menu.hidden;
    this.menu.hidden = !show;
    if (show) (this.menu.querySelector('[aria-checked="true"]') as HTMLElement | null)?.focus();
  }

  async toggleFullscreen() {
    const r = this.root as HTMLElement & { webkitRequestFullscreen?: () => void };
    const vid = this.video as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (r.requestFullscreen) await r.requestFullscreen().catch(() => undefined);
    else vid.webkitEnterFullscreen?.();
  }

  async togglePip() {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await this.video.requestPictureInPicture().catch(() => undefined);
  }

  private bindKeys() {
    this.root.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const v = this.video;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' && e.key !== ' ') return;
      switch (e.key) {
        case ' ':
        case 'k':
          if (target.tagName === 'BUTTON' && e.key === ' ') return;
          this.toggle();
          break;
        case 'ArrowLeft':
          this.seekTo(v.currentTime - 5);
          break;
        case 'ArrowRight':
          this.seekTo(v.currentTime + 5);
          break;
        case 'ArrowUp':
          v.volume = Math.min(1, v.volume + 0.1);
          v.muted = false;
          break;
        case 'ArrowDown':
          v.volume = Math.max(0, v.volume - 0.1);
          break;
        case 'f':
        case 'F':
          void this.toggleFullscreen();
          break;
        case 'm':
        case 'M':
          v.muted = !v.muted;
          break;
        case 'c':
        case 'C':
          this.toggleCaptions();
          break;
        case 'Escape':
          this.toggleMenu(false);
          return;
        default:
          return;
      }
      e.preventDefault();
      this.wake();
    });
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

  private showError() {
    this.errorEl.hidden = false;
  }
}
