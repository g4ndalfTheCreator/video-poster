/** Converts SRT subtitles to WebVTT (timestamps use '.' and a WEBVTT header is required). */
export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .trim();
  return `WEBVTT\n\n${body}\n`;
}

export function looksLikeVtt(text: string): boolean {
  return /^\uFEFF?WEBVTT/.test(text);
}
