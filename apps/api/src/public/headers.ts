import type { FastifyReply } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { Config } from '@vs/core';

export function newNonce(): string {
  return randomBytes(16).toString('base64');
}

/** Security headers for public HTML pages. Only same-origin resources are allowed. */
export function setPageHeaders(
  reply: FastifyReply,
  config: Config,
  opts: { nonce: string; embed?: boolean },
) {
  const frameAncestors = opts.embed ? '*' : "'none'";
  reply.header(
    'content-security-policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      `style-src 'self' 'nonce-${opts.nonce}'`,
      "img-src 'self' data:",
      "media-src 'self' blob:",
      "connect-src 'self'",
      "worker-src 'self' blob:",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      `frame-ancestors ${frameAncestors}`,
    ].join('; '),
  );
  reply.header('x-robots-tag', 'noindex, nofollow');
  reply.header('referrer-policy', 'strict-origin-when-cross-origin');
  reply.header('x-content-type-options', 'nosniff');
  if (!opts.embed) reply.header('x-frame-options', 'DENY');
  reply.header(
    'permissions-policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=(), browsing-topics=(), fullscreen=(self), picture-in-picture=(self)',
  );
  reply.header('cross-origin-opener-policy', 'same-origin');
  reply.header('cross-origin-resource-policy', 'same-origin');
  if (config.PUBLIC_SCHEME === 'https') reply.header('strict-transport-security', 'max-age=31536000');
  reply.header('cache-control', 'no-store');
  reply.header('content-type', 'text/html; charset=utf-8');
}
