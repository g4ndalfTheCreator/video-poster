import type { Player } from './player.js';
import { cueAt, parseSpriteVtt, type SpriteCue } from './sprite.js';

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
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
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

/** Accessible custom control bar for the classic watch page (seek with sprite thumbnails, quality menu, keys). */
export function classicControls(p: Player): void {
  const v = p.video;
  const r = p.root;
  const s = p.cfg.strings;
  const btn: Record<string, HTMLButtonElement> = {};
  let cues: SpriteCue[] = [];
  let hideTimer = 0;
  r.tabIndex = 0;
  r.setAttribute('role', 'region');
  r.setAttribute('aria-label', document.title);
  const big = h('button', 'vs-big', { type: 'button', 'aria-label': s.play });
  big.innerHTML = icon('play');
  big.onclick = () => p.toggle();
  const mk = (name: string, label: string, onClick: () => void, ic = name) => {
    const b = h('button', `vs-btn vs-${name}`, { type: 'button', 'aria-label': label, title: label });
    b.innerHTML = icon(ic);
    b.onclick = onClick;
    btn[name] = b;
    return b;
  };
  const seek = h('div', 'vs-seek', {
    role: 'slider',
    tabindex: '0',
    'aria-label': s.seek,
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-valuenow': '0',
  });
  const seekBuf = h('div', 'vs-seek-buf');
  const seekFill = h('div', 'vs-seek-fill');
  const thumb = h('div', 'vs-thumb', { 'aria-hidden': 'true' });
  seek.append(seekBuf, seekFill, thumb);
  const timeEl = h('span', 'vs-time', { 'aria-live': 'off' });
  const vol = h('input', 'vs-vol', {
    type: 'range',
    min: '0',
    max: '1',
    step: '0.05',
    'aria-label': s.volume,
  });
  vol.value = String(v.volume);
  vol.oninput = () => {
    v.volume = Number(vol.value);
    v.muted = v.volume === 0;
  };
  const menu = h('div', 'vs-menu', { role: 'menu', hidden: '' });
  const left = h('div', 'vs-left');
  left.append(
    mk('play', s.play, () => p.toggle()),
    mk('mute', s.mute, () => (v.muted = !v.muted), 'vol'),
    vol,
    timeEl,
  );
  const right = h('div', 'vs-right');
  if (v.textTracks.length) right.append(mk('cc', s.captions, () => p.toggleCaptions()));
  right.append(mk('hd', s.quality, () => toggleMenu()));
  btn.hd!.hidden = true;
  if (document.pictureInPictureEnabled) right.append(mk('pip', s.pip, () => void p.togglePip()));
  right.append(mk('fs', s.fullscreen, () => void p.toggleFullscreen()));
  const row = h('div', 'vs-row');
  row.append(left, right);
  const bar = h('div', 'vs-bar');
  bar.append(seek, row);
  r.append(big, bar, menu);

  const toggleMenu = (force?: boolean) => {
    const show = force ?? menu.hidden;
    menu.hidden = !show;
    if (show) menu.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  };
  const wake = () => {
    r.classList.add('vs-active');
    clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => r.classList.remove('vs-active'), 2500);
  };
  const updateTime = () => {
    const d = v.duration || (p.cfg.durationMs ?? 0) / 1000;
    const pct = d ? (v.currentTime / d) * 100 : 0;
    seekFill.style.width = `${pct}%`;
    const b = v.buffered;
    seekBuf.style.width = d && b.length ? `${(b.end(b.length - 1) / d) * 100}%` : '0';
    seek.setAttribute('aria-valuenow', String(Math.round(pct)));
    seek.setAttribute('aria-valuetext', `${fmt(v.currentTime)} / ${fmt(d)}`);
    timeEl.textContent = `${fmt(v.currentTime)} / ${fmt(d)}`;
  };
  const showThumb = (pos: number) => {
    const c = cueAt(cues, pos * (v.duration || (p.cfg.durationMs ?? 0) / 1000));
    const st = thumb.style;
    if (!c) {
      st.display = 'none';
      return;
    }
    st.display = 'block';
    st.width = `${c.w}px`;
    st.height = `${c.h}px`;
    st.backgroundImage = `url("${c.url}")`;
    st.backgroundPosition = `-${c.x}px -${c.y}px`;
    const w = seek.clientWidth;
    st.left = `${Math.min(Math.max(0, pos * w - c.w / 2), Math.max(0, w - c.w))}px`;
  };
  void fetch(p.cfg.spriteVtt, { credentials: 'same-origin' })
    .then(
      async (res) =>
        res.ok &&
        (cues = parseSpriteVtt(await res.text(), new URL(p.cfg.spriteVtt, location.href).toString())),
    )
    .catch(() => undefined);

  const sync = () => {
    const playing = !v.paused && !v.ended;
    btn.play!.innerHTML = icon(playing ? 'pause' : 'play');
    btn.play!.setAttribute('aria-label', playing ? s.pause : s.play);
    big.hidden = playing;
  };
  for (const ev of ['play', 'pause', 'ended']) v.addEventListener(ev, sync);
  for (const ev of ['timeupdate', 'durationchange', 'progress', 'seeking'])
    v.addEventListener(ev, updateTime);
  v.addEventListener('click', () => p.toggle());
  v.addEventListener('dblclick', () => void p.toggleFullscreen());
  v.addEventListener('volumechange', () => {
    const m = v.muted || v.volume === 0;
    btn.mute!.innerHTML = icon(m ? 'mute' : 'vol');
    btn.mute!.setAttribute('aria-label', m ? s.unmute : s.mute);
    vol.value = String(v.muted ? 0 : v.volume);
  });
  r.addEventListener('pointermove', wake);
  p.on((e) => {
    if (e.type === 'fullscreen')
      btn.fs!.setAttribute('aria-label', e.enabled ? s.exitFullscreen : s.fullscreen);
    else if (e.type === 'captions') {
      btn.cc?.classList.toggle('vs-on', !!e.lang);
      btn.cc?.setAttribute('aria-pressed', String(!!e.lang));
    } else if (e.type === 'manifest') buildQualityMenu();
  });
  const buildQualityMenu = () => {
    const hls = p.hls;
    if (!hls || hls.levels.length < 2) return;
    btn.hd!.hidden = false;
    menu.innerHTML = '';
    const items: [number, string][] = [
      [-1, s.auto],
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
        menu.querySelectorAll('.vs-mi').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
        p.emit('quality', {
          from: hls.levels[from]?.height,
          to: i < 0 ? null : hls.levels[i]?.height,
          auto: i < 0,
        });
        toggleMenu(false);
      };
      menu.append(b);
    }
  };

  // seek bar: pointer drag, hover thumbnails, keyboard
  const posFromEvent = (e: PointerEvent) => {
    const rect = seek.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  };
  let dragging = false;
  seek.addEventListener('pointerdown', (e) => {
    dragging = true;
    seek.setPointerCapture(e.pointerId);
    p.seekTo(posFromEvent(e) * (v.duration || 0));
  });
  seek.addEventListener('pointermove', (e) => {
    const pos = posFromEvent(e);
    if (dragging) p.seekTo(pos * (v.duration || 0));
    showThumb(pos);
  });
  seek.addEventListener('pointerup', () => (dragging = false));
  seek.addEventListener('pointerleave', () => (thumb.style.display = 'none'));
  seek.addEventListener('keydown', (e) => {
    if (e.key === 'Home') p.seekTo(0);
    else if (e.key === 'End') p.seekTo(v.duration);
    else return;
    e.preventDefault();
  });

  r.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' && e.key !== ' ') return;
    switch (e.key) {
      case ' ':
      case 'k':
        if (target.tagName === 'BUTTON' && e.key === ' ') return;
        p.toggle();
        break;
      case 'ArrowLeft':
        p.seekTo(v.currentTime - 5);
        break;
      case 'ArrowRight':
        p.seekTo(v.currentTime + 5);
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
        void p.toggleFullscreen();
        break;
      case 'm':
      case 'M':
        v.muted = !v.muted;
        break;
      case 'c':
      case 'C':
        p.toggleCaptions();
        break;
      case 'Escape':
        toggleMenu(false);
        return;
      default:
        return;
    }
    e.preventDefault();
    wake();
  });
  sync();
  updateTime();
}
