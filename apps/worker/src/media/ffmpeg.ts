import { spawn } from 'node:child_process';

const LOG_TAIL_BYTES = 64 * 1024;

export class FfmpegError extends Error {
  constructor(
    message: string,
    public readonly logTail: string,
  ) {
    super(message);
  }
}

/**
 * Runs ffmpeg with network protocols disabled. `onProgress` receives the processed media time in ms
 * (from `-progress pipe:1`). Returns the stderr tail (max 64 kB).
 */
export function runFfmpeg(
  args: string[],
  onProgress?: (outTimeMs: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const full = ['-hide_banner', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', ...args];
    if (onProgress) full.push('-progress', 'pipe:1', '-nostats');
    const p = spawn('ffmpeg', full, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    let tail = '';
    let buf = '';
    p.stderr.on('data', (d: Buffer) => {
      tail += d.toString();
      if (tail.length > LOG_TAIL_BYTES * 2) tail = tail.slice(-LOG_TAIL_BYTES);
    });
    p.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        const m = /^out_time_(?:us|ms)=(\d+)$/.exec(line);
        if (m && onProgress) onProgress(Math.round(Number(m[1]) / 1000));
      }
    });
    p.on('error', (e) => reject(new FfmpegError(e.message, tail.slice(-LOG_TAIL_BYTES))));
    p.on('close', (code) => {
      const t = tail.slice(-LOG_TAIL_BYTES);
      if (code === 0) resolve(t);
      else reject(new FfmpegError(`ffmpeg exited with code ${code}`, t));
    });
  });
}
