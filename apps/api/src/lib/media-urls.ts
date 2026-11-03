import { PREVIEW_SESSION, signMediaUrl, type Config } from '@vs/core';

export function previewUrls(config: Config, videoId: string, version: number, ttlSec = 6 * 3600) {
  if (!version) return null;
  const sign = (file: string) =>
    signMediaUrl({
      key: config.MEDIA_SIGNING_KEY,
      sessionId: PREVIEW_SESSION,
      videoId,
      version,
      file,
      ttlSec,
    });
  return {
    master: sign('master.m3u8'),
    poster: sign('poster.jpg'),
    sprite: sign('sprite.jpg'),
    spriteVtt: sign('sprite.vtt'),
  };
}
