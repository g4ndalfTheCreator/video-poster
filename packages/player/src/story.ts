import type { PageConfig } from './config.js';
import type { Player } from './player.js';

const $ = <T extends Element>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);

/**
 * Story flow: full-viewport video (muted autoplay, captions on, chapter bar, tap/hold to pause),
 * a one-tap feedback card at the end, then an automatic slide to the documents pane. The panes are a
 * CSS scroll-snap container, so swiping up works without this script too.
 */
export function startStory(cfg: PageConfig, player: Player): void {
  const v = player.video;
  const root = $<HTMLElement>('#vs-story');
  const docs = $<HTMLElement>('#vs-docs');
  const stage = $<HTMLElement>('.vs-story-player');
  if (!root || !docs || !stage) return;
  const s = cfg.strings;
  const chapters = cfg.story?.chapters.length ? cfg.story.chapters : [{ atMs: 0, title: '' }];
  let reachedVia: string | null = null;

  // captions on by default: most mobile viewers start muted
  const track = v.textTracks[0];
  if (track) track.mode = 'showing';

  // tap for sound
  const sound = document.createElement('button');
  sound.type = 'button';
  sound.className = 'vs-sound';
  sound.textContent = `🔇 ${s.tapForSound ?? ''}`;
  sound.onclick = (e) => {
    e.stopPropagation();
    v.muted = false;
    v.volume = 1;
    if (v.paused) void v.play().catch(() => undefined);
  };
  const syncSound = () => (sound.hidden = !v.muted);
  v.addEventListener('volumechange', syncSound);

  // chapter progress bar (stories style) + current chapter title
  const bar = document.createElement('div');
  bar.className = 'vs-chapters';
  const title = document.createElement('div');
  title.className = 'vs-chapter-title';
  const segs = chapters.map((c, i) => {
    const seg = document.createElement('button');
    seg.type = 'button';
    seg.className = 'vs-seg';
    seg.setAttribute('aria-label', c.title || `${i + 1}`);
    seg.innerHTML = '<i></i>';
    seg.onclick = (e) => {
      e.stopPropagation();
      v.currentTime = c.atMs / 1000;
      player.emit('chapter', { index: i });
    };
    bar.append(seg);
    return seg;
  });
  let current = -1;
  const sync = () => {
    const d = v.duration || 0;
    const t = v.currentTime * 1000;
    chapters.forEach((c, i) => {
      const end = chapters[i + 1]?.atMs ?? d * 1000;
      const pct = end > c.atMs ? Math.min(1, Math.max(0, (t - c.atMs) / (end - c.atMs))) : 0;
      (segs[i]!.firstChild as HTMLElement).style.transform = `scaleX(${pct})`;
      if (t >= c.atMs && t < end && current !== i) {
        current = i;
        title.textContent = c.title;
      }
    });
  };
  v.addEventListener('timeupdate', sync);
  stage.append(bar, title, sound);
  syncSound();

  // tap toggles, hold pauses while held; vertical movement is a swipe, not a tap
  let downAt = 0;
  let downY = 0;
  let held = false;
  let holdTimer = 0;
  v.addEventListener('pointerdown', (e) => {
    downAt = Date.now();
    downY = e.clientY;
    held = false;
    holdTimer = window.setTimeout(() => {
      if (!v.paused) {
        held = true;
        v.pause();
      }
    }, 250);
  });
  v.addEventListener('pointerup', (e) => {
    clearTimeout(holdTimer);
    if (Math.abs(e.clientY - downY) > 12) return;
    if (held) void v.play().catch(() => undefined);
    else if (Date.now() - downAt < 250) {
      if (v.muted && !v.paused) {
        v.muted = false; // first tap on a muted autoplay: sound on, keep playing
        return;
      }
      player.toggle();
    }
  });
  v.addEventListener('pointercancel', () => clearTimeout(holdTimer));

  const goDocs = (via: 'ended' | 'swipe' | 'button') => {
    if (!reachedVia) {
      reachedVia = via;
      player.emit('story_documents', { via });
    }
    docs.scrollIntoView({
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  };
  // swipe / scroll to the documents pane
  new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          if (!v.paused) v.pause();
          if (!reachedVia) goDocs('swipe');
        }
      }
    },
    { threshold: 0.6 },
  ).observe(docs);
  $<HTMLAnchorElement>('.vs-swipe')?.addEventListener('click', (e) => {
    e.preventDefault();
    goDocs('button');
  });

  // keyboard (desktop): space/k play-pause, m mute, c captions, ↓/PageDown documents, ↑/PageUp video
  const stagePane = $<HTMLElement>('.vs-stage');
  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    if (
      e.ctrlKey ||
      e.metaKey ||
      e.altKey ||
      /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(target.tagName) ||
      stage.contains(target)
    )
      return;
    const k = e.key;
    if (k === ' ' || k === 'k') player.toggle();
    else if (k === 'm' || k === 'M') v.muted = !v.muted;
    else if (k === 'c' || k === 'C') player.toggleCaptions();
    else if (k === 'ArrowDown' || k === 'PageDown') goDocs('button');
    else if (k === 'ArrowUp' || k === 'PageUp') stagePane?.scrollIntoView({ behavior: 'smooth' });
    else return;
    e.preventDefault();
  });

  // feedback (card at the end + form on the documents pane)
  let answered = false;
  const send = (rating: string, comment?: string) =>
    fetch(cfg.feedbackUrl ?? '/t/v1/feedback', {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: cfg.token, rating, comment }),
    }).catch(() => undefined);
  const forms = Array.from(document.querySelectorAll<HTMLFormElement>('form[data-feedback]'));
  const card = $<HTMLElement>('.vs-card');
  let advance = 0;
  const done = (f: HTMLFormElement) => {
    $<HTMLElement>('.vs-fb-row', f)!.hidden = true;
    $<HTMLElement>('.vs-fb-more', f)!.hidden = true;
    $<HTMLElement>('.vs-fb-send', f)!.hidden = true;
    $<HTMLElement>('.vs-fb-q', f)!.hidden = true;
    $<HTMLElement>('.vs-fb-thanks', f)!.hidden = false;
  };
  for (const f of forms) {
    let rating = '';
    f.querySelectorAll<HTMLButtonElement>('.vs-fb-btn').forEach((b) => {
      b.onclick = () => {
        rating = b.dataset.rating!;
        f.querySelectorAll('.vs-fb-btn').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        $<HTMLElement>('.vs-fb-more', f)!.hidden = false;
        $<HTMLElement>('.vs-fb-send', f)!.hidden = false;
        answered = true;
        void send(rating);
        // one tap is enough: continue automatically unless the viewer starts typing
        if (f.dataset.feedback === 'card') advance = window.setTimeout(() => finishCard(), 3500);
      };
    });
    $<HTMLTextAreaElement>('textarea', f)!.onfocus = () => clearTimeout(advance);
    f.onsubmit = (e) => {
      e.preventDefault();
      const comment = $<HTMLTextAreaElement>('textarea', f)!.value.trim();
      if (rating) void send(rating, comment || undefined);
      forms.forEach(done);
      if (f.dataset.feedback === 'card') finishCard();
    };
  }
  const finishCard = () => {
    clearTimeout(advance);
    if (answered) forms.forEach(done);
    if (card) card.hidden = true;
    goDocs('ended');
  };
  $<HTMLButtonElement>('.vs-fb-skip')?.addEventListener('click', finishCard);
  v.addEventListener('ended', () => {
    if (!card || answered) return goDocs('ended');
    card.hidden = false;
    player.emit('story_feedback_shown');
    $<HTMLButtonElement>('.vs-fb-btn', card)?.focus();
  });
}
