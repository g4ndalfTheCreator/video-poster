export interface SpriteCue {
  start: number;
  end: number;
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const ts = (s: string) => {
  const p = s.trim().split(':').map(Number);
  return p.length === 3 ? p[0]! * 3600 + p[1]! * 60 + p[2]! : p[0]! * 60 + p[1]!;
};

/** Parses a thumbnail WebVTT (`sprite.jpg#xywh=x,y,w,h`). Relative URLs resolve against the VTT URL. */
export function parseSpriteVtt(text: string, base: string): SpriteCue[] {
  const cues: SpriteCue[] = [];
  const blocks = text.replace(/\r/g, '').split('\n\n');
  for (const b of blocks) {
    const lines = b.split('\n').filter(Boolean);
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0 || !lines[i + 1]) continue;
    const [a, z] = lines[i]!.split('-->');
    const m = /^(.*)#xywh=(\d+),(\d+),(\d+),(\d+)$/.exec(lines[i + 1]!.trim());
    if (!m) continue;
    cues.push({
      start: ts(a!),
      end: ts(z!),
      url: new URL(m[1]!, base).toString(),
      x: +m[2]!,
      y: +m[3]!,
      w: +m[4]!,
      h: +m[5]!,
    });
  }
  return cues;
}

export function cueAt(cues: SpriteCue[], t: number): SpriteCue | undefined {
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cues[mid]!;
    if (t < c.start) hi = mid - 1;
    else if (t >= c.end) lo = mid + 1;
    else return c;
  }
  return cues[cues.length - 1];
}
