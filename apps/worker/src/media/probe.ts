import { spawn } from 'node:child_process';

export interface ProbeStream {
  index: number;
  codec_type: 'video' | 'audio' | 'subtitle' | 'data' | string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  tags?: Record<string, string>;
  side_data_list?: { side_data_type?: string; rotation?: number }[];
  disposition?: { attached_pic?: number };
}
export interface ProbeResult {
  streams: ProbeStream[];
  format: { format_name: string; duration?: string; size?: string; bit_rate?: string };
}

export const ALLOWED_CONTAINERS = ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2', 'matroska', 'webm'];
export const ALLOWED_VIDEO_CODECS = ['h264', 'hevc', 'vp9', 'av1', 'prores'];

export class ValidationError extends Error {}

export function runFfprobe(file: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      'ffprobe',
      ['-v', 'error', '-protocol_whitelist', 'file', '-show_streams', '-show_format', '-of', 'json', file],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    let err = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0)
        return reject(new ValidationError(`ffprobe failed: ${err.trim().slice(0, 500) || `exit ${code}`}`));
      try {
        resolve(JSON.parse(out) as ProbeResult);
      } catch {
        reject(new ValidationError('ffprobe returned invalid JSON'));
      }
    });
  });
}

export interface MediaInfo {
  durationMs: number;
  /** Display dimensions (rotation applied). */
  width: number;
  height: number;
  rotation: number;
  fps: number;
  hasAudio: boolean;
  videoCodec: string;
  container: string;
}

function parseRate(r: string | undefined): number {
  if (!r) return 0;
  const [a, b] = r.split('/').map(Number);
  return b ? (a ?? 0) / b : (a ?? 0);
}

/** Validates an ffprobe result against the allowed containers/codecs and duration limit. */
export function validateProbe(p: ProbeResult, maxDurationS: number): MediaInfo {
  const video = p.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video) throw new ValidationError('no video stream');
  const containers = p.format.format_name.split(',');
  if (!containers.some((c) => ALLOWED_CONTAINERS.includes(c)))
    throw new ValidationError(`container not allowed: ${p.format.format_name}`);
  const codec = video.codec_name ?? 'unknown';
  if (!ALLOWED_VIDEO_CODECS.includes(codec)) throw new ValidationError(`video codec not allowed: ${codec}`);
  const duration = Number(p.format.duration ?? 0);
  if (!Number.isFinite(duration) || duration <= 0) throw new ValidationError('unknown duration');
  if (duration > maxDurationS)
    throw new ValidationError(`duration ${Math.round(duration)} s exceeds limit ${maxDurationS} s`);
  if (!video.width || !video.height) throw new ValidationError('unknown video dimensions');
  const rotTag = Number(video.tags?.rotate ?? 0);
  const rotSide = video.side_data_list?.find((s) => typeof s.rotation === 'number')?.rotation ?? 0;
  const rotation = ((Math.round(rotSide || rotTag) % 360) + 360) % 360;
  const swap = rotation === 90 || rotation === 270;
  return {
    durationMs: Math.round(duration * 1000),
    width: swap ? video.height : video.width,
    height: swap ? video.width : video.height,
    rotation,
    fps: parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate) || 30,
    hasAudio: p.streams.some((s) => s.codec_type === 'audio'),
    videoCodec: codec,
    container: containers[0]!,
  };
}
