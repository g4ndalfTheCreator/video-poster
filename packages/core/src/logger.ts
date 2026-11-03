import { pino, type Logger } from 'pino';

/** Structured JSON logger. Never log raw IPs or tokens: they are redacted/truncated here. */
export function createLogger(name: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    name,
    level,
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.headers["x-forwarded-for"]',
        'res.headers["set-cookie"]',
        '*.password',
        '*.token',
        '*.password_hash',
        '*.totp_secret',
      ],
      censor: '[redacted]',
    },
    serializers: {
      req(req: { method?: string; url?: string; ip?: string }) {
        return { method: req.method, url: maskUrl(req.url ?? ''), ip: truncateForLog(req.ip) };
      },
    },
  });
}

/** Masks tokens in URLs (media tokens, ingest tokens). */
export function maskUrl(url: string): string {
  return url.replace(/\/media\/[^/]+\/\d+\//, '/media/***/').replace(/([?&](?:token|st|t)=)[^&]+/g, '$1***');
}

export function truncateForLog(ip: string | undefined): string | undefined {
  if (!ip) return ip;
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + '::/48';
  const p = ip.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0/24` : undefined;
}
