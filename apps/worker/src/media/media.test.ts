import { describe, it, expect } from 'vitest';
import { computeLadder, spriteVtt } from './ladder.js';
import { validateProbe, ValidationError, type ProbeResult } from './probe.js';
import { buildHlsArgs } from './transcode.js';
import { srtToVtt } from '@vs/shared';

const probe = (
  over: Partial<ProbeResult['streams'][number]> = {},
  fmt: Partial<ProbeResult['format']> = {},
): ProbeResult => ({
  streams: [
    {
      index: 0,
      codec_type: 'video',
      codec_name: 'h264',
      width: 1920,
      height: 1080,
      avg_frame_rate: '30/1',
      ...over,
    },
    { index: 1, codec_type: 'audio', codec_name: 'aac' },
  ],
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '30.0', ...fmt },
});

describe('ladder', () => {
  it('1080p landscape gets all four rungs', () => {
    expect(computeLadder(1920, 1080).map((r) => `${r.width}x${r.height}@${r.bitrateKbps}`)).toEqual([
      '1920x1080@5000',
      '1280x720@2800',
      '854x480@1400',
      '640x360@800',
    ]);
  });
  it('portrait video is scaled by its shorter side', () => {
    expect(computeLadder(1080, 1920).map((r) => `${r.width}x${r.height}`)).toEqual([
      '1080x1920',
      '720x1280',
      '480x854',
      '360x640',
    ]);
  });
  it('never upscales', () => {
    expect(computeLadder(1280, 720).map((r) => r.name)).toEqual(['720p', '480p', '360p']);
    expect(computeLadder(320, 240).map((r) => `${r.width}x${r.height}`)).toEqual(['320x240']);
  });
});

describe('probe validation', () => {
  it('accepts mp4/h264', () => {
    const i = validateProbe(probe(), 900);
    expect(i).toMatchObject({ durationMs: 30_000, width: 1920, height: 1080, hasAudio: true });
  });
  it('applies rotation metadata (phone video)', () => {
    const i = validateProbe(
      probe({ side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] }),
      900,
    );
    expect([i.width, i.height]).toEqual([1080, 1920]);
  });
  it('rejects too long, wrong codec, wrong container, no video', () => {
    expect(() => validateProbe(probe({}, { duration: '901' }), 900)).toThrow(/exceeds/);
    expect(() => validateProbe(probe({ codec_name: 'mpeg4' }), 900)).toThrow(ValidationError);
    expect(() => validateProbe(probe({}, { format_name: 'avi' }), 900)).toThrow(/container/);
    expect(() =>
      validateProbe(
        { streams: [{ index: 0, codec_type: 'audio' }], format: { format_name: 'mp4', duration: '1' } },
        900,
      ),
    ).toThrow(/no video/);
  });
});

describe('hls args', () => {
  it('maps one audio per rendition and uses fMP4 4 s segments with 2 s keyframes', () => {
    const info = validateProbe(probe(), 900);
    const args = buildHlsArgs('/in.mp4', '/out', info, computeLadder(1920, 1080), {
      preset: 'medium',
      loudnorm: true,
    });
    const s = args.join(' ');
    expect(s).toContain('-hls_time 4');
    expect(s).toContain('-hls_segment_type fmp4');
    expect(s).toContain('expr:gte(t,n_forced*2)');
    expect(s).toContain('loudnorm=I=-16');
    expect(s).toContain('v:3,a:3,name:360p');
    expect(s).toContain('-b:a 128k');
  });
});

describe('vtt', () => {
  it('builds sprite vtt', () => {
    const vtt = spriteVtt(5000, 2, 160, 90, 10);
    expect(vtt).toContain('00:00:00.000 --> 00:00:02.000\nsprite.jpg#xywh=0,0,160,90');
    expect(vtt).toContain('00:00:04.000 --> 00:00:05.000\nsprite.jpg#xywh=320,0,160,90');
  });
  it('converts srt', () => {
    expect(srtToVtt('1\r\n00:00:01,000 --> 00:00:02,500\r\nHei\r\n')).toBe(
      'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nHei\n',
    );
  });
});
