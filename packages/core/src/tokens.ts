import { hmacBase64Url, signToken, verifyToken, safeEqual } from './crypto.js';

export interface IngestToken {
  l: string; // link id
  s: string; // session id
  v: string; // video id
  exp: number;
}

export function createIngestToken(key: string, linkId: string, sessionId: string, videoId: string, ttlSec = 24 * 3600): string {
  return signToken(key, { l: linkId, s: sessionId, v: videoId, exp: Math.floor(Date.now() / 1000) + ttlSec });
}

export function verifyIngestToken(key: string, token: string): IngestToken | null {
  return verifyToken<IngestToken>(key, token);
}

/** Short signature binding a session to a public URL (CTA redirect, attachment, download, captions). */
export function sessionSig(key: string, sessionId: string, purpose: string): string {
  return hmacBase64Url(key, `${purpose}:${sessionId}`).slice(0, 22);
}

export function verifySessionSig(key: string, sessionId: string, purpose: string, sig: string): boolean {
  return safeEqual(sig, sessionSig(key, sessionId, purpose));
}
