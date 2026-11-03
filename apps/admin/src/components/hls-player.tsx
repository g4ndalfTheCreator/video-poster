import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import Hls from 'hls.js';

export interface PlayerHandle {
  currentTimeMs(): number;
  seek(ms: number): void;
}

/** Minimal HLS preview player for the admin (native controls). */
export const HlsPlayer = forwardRef<
  PlayerHandle,
  { src: string; poster?: string; captions?: { src: string; lang: string; label: string }[] }
>(function HlsPlayer({ src, poster, captions = [] }, ref) {
  const video = useRef<HTMLVideoElement>(null);
  useImperativeHandle(ref, () => ({
    currentTimeMs: () => Math.round((video.current?.currentTime ?? 0) * 1000),
    seek: (ms) => {
      if (video.current) video.current.currentTime = ms / 1000;
    },
  }));
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    if (Hls.isSupported()) {
      const hls = new Hls({ maxBufferLength: 10 });
      hls.loadSource(src);
      hls.attachMedia(el);
      return () => hls.destroy();
    }
    el.src = src;
    return undefined;
  }, [src]);
  return (
    <video
      ref={video}
      controls
      playsInline
      poster={poster}
      className="aspect-video w-full rounded-md bg-black"
      crossOrigin="anonymous"
    >
      {captions.map((c) => (
        <track key={c.src} kind="subtitles" src={c.src} srcLang={c.lang} label={c.label} />
      ))}
    </video>
  );
});
