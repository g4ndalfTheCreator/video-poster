export interface PlayerStrings {
  play: string;
  pause: string;
  mute: string;
  unmute: string;
  volume: string;
  seek: string;
  fullscreen: string;
  exitFullscreen: string;
  captions: string;
  captionsOff: string;
  quality: string;
  auto: string;
  pip: string;
  error: string;
}

/** Embedded by the server as <script type="application/json" id="vs-config">. */
export interface PageConfig {
  v: 1;
  slug: string;
  sessionId: string;
  token: string;
  master: string;
  spriteVtt: string;
  durationMs: number | null;
  autoplayMuted: boolean;
  telemetry: 'full' | 'off';
  playbackUrl: string;
  ingestUrl: string;
  beaconUrl: string;
  tokenExpiresAt: number;
  ctas: { id: string; host: string | null }[];
  strings: PlayerStrings;
}

export function readConfig(doc: Document = document): PageConfig | null {
  const el = doc.getElementById('vs-config');
  if (!el?.textContent) return null;
  try {
    return JSON.parse(el.textContent) as PageConfig;
  } catch {
    return null;
  }
}
