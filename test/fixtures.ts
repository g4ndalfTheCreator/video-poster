import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const FIXTURES = path.resolve(import.meta.dirname, '../fixtures');
export const SAMPLE_1080P = path.join(FIXTURES, 'sample-1080p.mp4');
export const SAMPLE_PORTRAIT = path.join(FIXTURES, 'sample-portrait.mp4');
export const INVALID_VIDEO = path.join(FIXTURES, 'invalid.mp4');

/** Generates deterministic test media with ffmpeg (not committed to git). */
export function ensureFixtures(): void {
  mkdirSync(FIXTURES, { recursive: true });
  const gen = (out: string, size: string, seconds: number) => {
    if (existsSync(out)) return;
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${size}:rate=30`,
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      String(seconds),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '30',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      out,
    ]);
  };
  gen(SAMPLE_1080P, '1920x1080', 30);
  gen(SAMPLE_PORTRAIT, '720x1280', 6);
  if (!existsSync(INVALID_VIDEO)) writeFileSync(INVALID_VIDEO, 'this is not a video file\n'.repeat(100));
}
