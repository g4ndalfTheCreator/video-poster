import { LADDER } from '@vs/shared';

export interface Rung {
  name: string;
  /** Size of the shorter side (e.g. 720 for 1280x720 or 720x1280). */
  short: number;
  width: number;
  height: number;
  bitrateKbps: number;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Computes the HLS ladder for a source. Never upscales; portrait videos are scaled by their
 * shorter side. A source smaller than the lowest rung gets a single rendition at source size.
 */
export function computeLadder(width: number, height: number): Rung[] {
  const portrait = height > width;
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  const rungs = LADDER.filter((r) => r.height <= short);
  const pick = rungs.length
    ? rungs
    : [{ height: even(short), bitrateKbps: LADDER[LADDER.length - 1]!.bitrateKbps }];
  return pick.map((r) => {
    const s = r.height;
    const l = even((long * s) / short);
    return {
      name: `${s}p`,
      short: s,
      width: portrait ? s : l,
      height: portrait ? l : s,
      bitrateKbps: r.bitrateKbps,
    };
  });
}

export function spriteVtt(
  durationMs: number,
  intervalS: number,
  thumbW: number,
  thumbH: number,
  columns: number,
  file = 'sprite.jpg',
): string {
  const lines = ['WEBVTT', ''];
  const count = Math.max(1, Math.ceil(durationMs / 1000 / intervalS));
  const ts = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec.toFixed(3).padStart(6, '0')}`;
  };
  for (let i = 0; i < count; i++) {
    const start = i * intervalS;
    const end = Math.min((i + 1) * intervalS, durationMs / 1000);
    const x = (i % columns) * thumbW;
    const y = Math.floor(i / columns) * thumbH;
    lines.push(`${ts(start)} --> ${ts(end)}`, `${file}#xywh=${x},${y},${thumbW},${thumbH}`, '');
  }
  return lines.join('\n');
}
